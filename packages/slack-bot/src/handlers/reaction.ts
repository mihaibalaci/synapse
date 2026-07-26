/**
 * 📌 Reaction handler — when someone pins a message with 📌 (pushpin),
 * capture it as an atomic insight to the knowledge base.
 *
 * This is the lowest-friction capture method: just react with 📌 to save.
 */

import type { ReactionAddedEvent } from '@slack/types';
import { WebClient } from '@slack/web-api';
import { api, getOrgId } from '../api-client.js';

const CAPTURE_EMOJI = 'pushpin'; // 📌

export async function handleReaction({
  event,
  client,
}: {
  event: ReactionAddedEvent;
  client: WebClient;
}) {
  if (event.reaction !== CAPTURE_EMOJI) return;
  if (!event.item || event.item.type !== 'message') return;

  const { channel, ts } = event.item as { channel: string; ts: string };

  try {
    // Fetch the message that was reacted to
    const result = await client.conversations.history({
      channel,
      latest: ts,
      inclusive: true,
      limit: 1,
    });

    const message = result.messages?.[0];
    if (!message?.text) return;

    // Also try to get thread context (parent + replies)
    let threadMessages: string[] = [message.text];
    if (message.thread_ts) {
      const thread = await client.conversations.replies({
        channel,
        ts: message.thread_ts,
        limit: 10,
      });
      threadMessages = (thread.messages ?? [])
        .filter((m: any) => m.text)
        .map((m: any) => m.text as string);
    }

    const content = threadMessages.join('\n---\n');

    // Capture as a passive event
    await api('/api/v1/capture/event', 'POST', {
      type: 'slack_thread',
      source: 'slack',
      content,
      metadata: {
        channel,
        messageTs: ts,
        reactedBy: event.user,
        threadLength: threadMessages.length,
      },
      captureMode: 'active',
      developerId: event.user,
      organizationId: getOrgId(),
      timestamp: new Date().toISOString(),
    });

    // Acknowledge with a reply (only in thread to avoid noise)
    if (message.thread_ts) {
      await client.chat.postMessage({
        channel,
        thread_ts: message.thread_ts,
        text: `📌 Captured to knowledge base by <@${event.user}>`,
      });
    }
  } catch (error) {
    // Silently fail — reaction captures are best-effort
    console.error('Reaction capture failed:', error);
  }
}
