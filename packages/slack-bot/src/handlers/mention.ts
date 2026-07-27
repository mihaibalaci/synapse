/**
 * @synapse <question> — Answer questions via app mention.
 * Replies in-thread with knowledge from the store.
 */

import type { AppMentionEvent } from '@slack/types';
import { api, getOrgId } from '../api-client.js';

export async function handleMention({
  event,
  say,
}: {
  event: AppMentionEvent;
  say: (msg: any) => Promise<any>;
}) {
  // Strip the bot mention from the text
  const query = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!query) {
    await say({ text: 'Ask me anything about our engineering knowledge! Example: "How do we handle auth?"', thread_ts: event.ts });
    return;
  }

  try {
    const result = await api('/api/v1/context', 'POST', {
      query,
      maxTokens: 2000,
      developerId: event.user,
      organizationId: getOrgId(),
    });

    if (!result.context?.length) {
      await say({
        text: `I don't have knowledge about that yet. Once someone has an AI session on this topic, it'll appear here.`,
        thread_ts: event.thread_ts ?? event.ts,
      });
      return;
    }

    const answer = result.context.map((c: any) =>
      `*${c.title}*\n${c.content.substring(0, 400)}${c.content.length > 400 ? '...' : ''}`
    ).join('\n\n---\n\n');

    await say({
      text: `Here's what I found:\n\n${answer}\n\n_${result.returnedResults} results · ~${result.estimatedTokens} tokens_`,
      thread_ts: event.thread_ts ?? event.ts,
    });
  } catch (error: any) {
    await say({
      text: `❌ Sorry, I couldn't search the knowledge base: ${error.message}`,
      thread_ts: event.thread_ts ?? event.ts,
    });
  }
}
