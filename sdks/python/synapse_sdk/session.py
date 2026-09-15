"""Automatic session tracking — accumulates messages and captures periodically."""

from __future__ import annotations

import threading
import uuid
from typing import Dict, List, Optional

from synapse_sdk.client import SynapseClient

# Messages buffered before a batch is pushed. Small on purpose: a crash or a
# forgotten close() can only lose what is still in the buffer, and every batch
# carries the conversation id so Synapse reassembles them during compaction.
DEFAULT_FLUSH_THRESHOLD = 4


class SessionTracker:
    """Automatically captures conversations when they reach a threshold.

    Usage:
        tracker = SessionTracker(client, repository="org/repo")
        tracker.add("user", "We should use Redis for caching")
        tracker.add("assistant", "Good choice, I'll note the 5-min TTL")
        # Auto-captures every 4 messages, or when flush_interval elapses
        tracker.flush()  # Or flush manually

    Every batch pushed by one tracker shares a conversation id, so compaction
    consolidates them back into a single conversation before summarizing.
    Call new_conversation() when a genuinely new discussion starts.
    """

    def __init__(
        self,
        client: SynapseClient,
        repository: str = "",
        language: str = "",
        source: str = "sdk-python-tracker",
        flush_threshold: int = DEFAULT_FLUSH_THRESHOLD,
        flush_interval: float = 300.0,  # seconds
        auto_flush: bool = True,
        conversation_id: Optional[str] = None,
    ):
        self.client = client
        self.repository = repository
        self.language = language
        self.source = source
        # The API requires at least 2 messages per capture, so a threshold below
        # that would buffer forever without ever producing a valid batch.
        self.flush_threshold = max(2, flush_threshold)
        self.flush_interval = flush_interval
        self.conversation_id = conversation_id or str(uuid.uuid4())
        self._messages: List[Dict[str, str]] = []
        # Last message already pushed. The API requires two messages per batch,
        # so a conversation ending on a single buffered message could never be
        # sent; replaying this one alongside it keeps the final message instead
        # of dropping it. The overlap is handled by ingestion deduplication.
        self._last_sent: Optional[Dict[str, str]] = None
        self._lock = threading.Lock()
        self._timer: Optional[threading.Timer] = None
        self._auto_flush = auto_flush
        if auto_flush and flush_interval > 0:
            self._schedule_flush()

    def add(self, role: str, content: str) -> None:
        """Add a message to the current session."""
        with self._lock:
            self._messages.append({"role": role, "content": content})
            if len(self._messages) >= self.flush_threshold:
                self._do_flush()

    def flush(self) -> Optional[Dict]:
        """Flush accumulated messages to Synapse. Returns None if nothing to flush."""
        with self._lock:
            return self._do_flush()

    def pending(self) -> int:
        """Number of messages buffered but not yet pushed."""
        with self._lock:
            return len(self._messages)

    def new_conversation(self, conversation_id: Optional[str] = None) -> str:
        """Flush the current buffer and start a new conversation.

        Batches added after this call are grouped separately from earlier ones.
        Returns the new conversation id.
        """
        with self._lock:
            self._do_flush(final=True)
            self.conversation_id = conversation_id or str(uuid.uuid4())
            self._last_sent = None
            return self.conversation_id

    def _do_flush(self, final: bool = False) -> Optional[Dict]:
        if not self._messages:
            return None

        messages = self._messages[:]
        if len(messages) < 2:
            # Below the API minimum. Keep buffering unless this is the last
            # chance to send, in which case pair it with the previous message.
            if not final or self._last_sent is None:
                return None
            messages = [self._last_sent] + messages

        self._messages = []
        try:
            response = self.client.capture(
                messages=messages,
                source=self.source,
                repository=self.repository,
                language=self.language,
                conversation_id=self.conversation_id,
            )
            self._last_sent = messages[-1]
            return response
        except Exception:
            # Re-queue on failure so data isn't lost. Only the messages that were
            # actually buffered are restored; a replayed one is not re-added.
            self._messages = self._messages_from(messages) + self._messages
            return None

    def _messages_from(self, sent: List[Dict[str, str]]) -> List[Dict[str, str]]:
        """Strip a replayed context message from a failed batch."""
        if self._last_sent is not None and sent and sent[0] is self._last_sent:
            return sent[1:]
        return sent

    def _schedule_flush(self) -> None:
        self._timer = threading.Timer(self.flush_interval, self._timed_flush)
        self._timer.daemon = True
        self._timer.start()

    def _timed_flush(self) -> None:
        self.flush()
        if self._auto_flush:
            self._schedule_flush()

    def close(self) -> None:
        """Flush remaining messages and stop the timer."""
        if self._timer:
            self._timer.cancel()
        with self._lock:
            self._do_flush(final=True)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __del__(self):
        if self._timer:
            self._timer.cancel()
