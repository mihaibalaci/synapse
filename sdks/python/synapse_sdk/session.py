"""Automatic session tracking — accumulates messages and captures periodically."""

from __future__ import annotations

import threading
import time
from typing import Dict, List, Optional

from synapse_sdk.client import SynapseClient


class SessionTracker:
    """Automatically captures conversations when they reach a threshold.

    Usage:
        tracker = SessionTracker(client, repository="org/repo")
        tracker.add("user", "We should use Redis for caching")
        tracker.add("assistant", "Good choice, I'll note the 5-min TTL")
        # Auto-captures when flush_threshold messages accumulate or flush_interval elapses
        tracker.flush()  # Or flush manually
    """

    def __init__(
        self,
        client: SynapseClient,
        repository: str = "",
        language: str = "",
        source: str = "sdk-python-tracker",
        flush_threshold: int = 10,
        flush_interval: float = 300.0,  # seconds
        auto_flush: bool = True,
    ):
        self.client = client
        self.repository = repository
        self.language = language
        self.source = source
        self.flush_threshold = flush_threshold
        self.flush_interval = flush_interval
        self._messages: List[Dict[str, str]] = []
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

    def _do_flush(self) -> Optional[Dict]:
        if len(self._messages) < 2:
            return None
        messages = self._messages[:]
        self._messages = []
        try:
            return self.client.capture(
                messages=messages,
                source=self.source,
                repository=self.repository,
                language=self.language,
            )
        except Exception:
            # Re-queue on failure so data isn't lost
            self._messages = messages + self._messages
            return None

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
        self.flush()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()

    def __del__(self):
        if self._timer:
            self._timer.cancel()
