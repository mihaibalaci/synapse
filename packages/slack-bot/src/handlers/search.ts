/**
 * /recall <query> — Search knowledge base from Slack.
 * Returns top results as a formatted Slack message with blocks.
 */

import type { SlashCommand, AckFn, RespondFn } from '@slack/bolt';
import { api, getOrgId } from '../api-client.js';

export async function handleSearchCommand({
  command,
  ack,
  respond,
}: {
  command: SlashCommand;
  ack: AckFn<string>;
  respond: RespondFn;
}) {
  await ack();

  const query = command.text.trim();
  if (!query) {
    await respond({ text: 'Usage: `/recall <your question>`\nExample: `/ctx how do we deploy to production?`' });
    return;
  }

  try {
    const result = await api('/api/v1/search', 'POST', {
      query,
      topK: 3,
      strategy: 'hybrid',
      includeContent: true,
      developerId: command.user_id,
      organizationId: getOrgId(),
    });

    if (!result.results?.length) {
      await respond({ text: `No results found for: _${query}_` });
      return;
    }

    const blocks: any[] = [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*Results for:* _${query}_ (${result.latencyMs}ms)` },
      },
      { type: 'divider' },
    ];

    for (const r of result.results) {
      const score = Math.round(r.finalScore * 100);
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${r.title}* (${score}% match)\n${r.summary.substring(0, 200)}${r.summary.length > 200 ? '...' : ''}`,
        },
        accessory: r.repository ? {
          type: 'button',
          text: { type: 'plain_text', text: '👍 Useful' },
          action_id: `feedback_useful_${r.id}`,
          value: r.id,
        } : undefined,
      });

      if (r.codeSnippets?.[0]) {
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `\`\`\`${r.codeSnippets[0].code.substring(0, 300)}\`\`\``,
          },
        });
      }

      blocks.push({
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `📁 ${r.repository ?? 'unknown'} · 💬 ${r.language ?? ''} · 📅 ${r.createdAt?.substring(0, 10) ?? ''}`,
        }],
      });
    }

    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `_${result.totalCount} total results · ~${result.estimatedTokens} tokens_` }],
    });

    await respond({ blocks, response_type: 'ephemeral' });
  } catch (error: any) {
    await respond({ text: `❌ Search failed: ${error.message}` });
  }
}
