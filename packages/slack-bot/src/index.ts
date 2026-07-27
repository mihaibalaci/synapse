/**
 * Recall — Slack Bot
 *
 * Features:
 *   1. /synapse <query>          — Search knowledge base from any channel
 *   2. @synapse <question>   — Mention to ask a question (thread-friendly)
 *   3. 📌 emoji reaction     — Capture a thread as a decision/insight
 *   4. /synapse-save             — Capture the current thread to knowledge base
 *   5. Proactive suggestions — Bot watches for questions it can answer
 *
 * Environment:
 *   SLACK_BOT_TOKEN         — xoxb-... bot token
 *   SLACK_SIGNING_SECRET    — Signing secret from Slack app config
 *   SLACK_APP_TOKEN         — xapp-... for Socket Mode (dev) or omit for HTTP
 *   RECALL_API_URL    — API base URL
 *   RECALL_TOKEN  — Bearer token
 *   ORGANIZATION_ID         — Org scope
 */

import { App, LogLevel } from '@slack/bolt';
import { handleSearchCommand } from './handlers/search.js';
import { handleMention } from './handlers/mention.js';
import { handleSaveCommand } from './handlers/save.js';
import { handleReaction } from './handlers/reaction.js';

// ─── App Setup ───────────────────────────────────────────────────────────────

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: !!process.env.SLACK_APP_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  logLevel: LogLevel.INFO,
});

// ─── Slash Command: /ctx ─────────────────────────────────────────────────────

app.command('/synapse', handleSearchCommand);

// ─── Slash Command: /synapse-save ────────────────────────────────────────────────

app.command('/synapse-save', handleSaveCommand);

// ─── App Mention: @synapse <question> ────────────────────────────────────────

app.event('app_mention', handleMention);

// ─── Reaction: 📌 to capture a thread ────────────────────────────────────────

app.event('reaction_added', handleReaction);

// ─── Start ───────────────────────────────────────────────────────────────────

(async () => {
  const port = parseInt(process.env.PORT ?? '3001', 10);
  await app.start(port);
  console.log(`⚡ Recall Slack bot running (port ${port})`);
})();
