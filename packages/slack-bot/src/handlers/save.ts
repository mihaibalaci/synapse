/**
 * /recall-save — Capture the current thread as organizational knowledge.
 * Reads the thread messages and sends them to the knowledge base.
 */

import type { SlashCommand, AckFn, RespondFn } from '@slack/bolt';
import { WebClient } from '@slack/bolt';
import { api, getOrgId } from '../api-client.js';

export async function handleSaveCommand({
  command,
  ack,
  respond,
  client,
}: {
  command: SlashCommand;
  ack: AckFn<string>;
  respond: RespondFn;
  client: WebClient;
}) {
  await ack();

  // This command should be used in a thread
  const channelId = command.channel_id;
  const annotation = command.text.trim() || undefined;

  try {
    // Get recent messages from the channel (or thread if available)
    const history = await client.conversations.history({
      channel: channelId,
      limit: 30,
    });

    const messages = (history.messages ?? [])
      .filter((m: any) => m.text && !m.bot_id)
      .reverse()
      .map((m: any) => ({
        role: 'user' as const,
        content: m.text ?? '',
        timestamp: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : new Date().toISOString(),
      }));

    if (messages.length < 2) {
      await respond({ text: 'Not enough messages to capture. Use this in a thread with a meaningful discussion.' });
      return;
    }

    const result = await api('/api/v1/capture/active', 'POST', {
      clientId: crypto.randomUUID(),
      developerId: command.user_id,
      organizationId: getOrgId(),
      messages: messages.map((m: any) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
        codeBlocks: [],
        timestamp: m.timestamp,
        tokenCount: Math.ceil(m.content.length / 4),
        toolCalls: [],
      })),
      metadata: {
        project: 'slack-captured',
        language: 'unknown',
        languages: [],
        frameworks: [],
        aiProvider: 'custom',
        aiModel: 'slack-thread',
        idePlugin: 'slack-bot',
        tags: ['slack-thread', `channel-${channelId}`],
      },
      startedAt: messages[0].timestamp,
      endedAt: messages[messages.length - 1].timestamp,
      totalTokens: messages.reduce((s: number, m: any) => s + Math.ceil(m.content.length / 4), 0),
      tags: ['slack-thread'],
      annotation,
      promoteTier2: true,
    });

    await respond({
      text: `✅ Thread captured to knowledge base!\n` +
        `Session: \`${result.sessionId}\`\n` +
        `Messages: ${messages.length}\n` +
        (annotation ? `Note: _${annotation}_` : ''),
      response_type: 'ephemeral',
    });
  } catch (error: any) {
    await respond({ text: `❌ Failed to capture thread: ${error.message}` });
  }
}
