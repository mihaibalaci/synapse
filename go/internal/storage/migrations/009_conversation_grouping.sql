-- Migration 009: Conversation Grouping for Ordered Compaction
--
-- Captures arrive as small batches (the SDK trackers flush every few messages),
-- so one logical conversation produces several session rows. Without a shared
-- identity those batches could only ever be compacted independently, which
-- fragments a single conversation into unrelated summaries.
--
-- Two additions:
--   1. sessions.conversation_id: client-supplied identity shared by every batch
--      of the same conversation. Empty string means "unknown", which keeps every
--      existing row and every caller that does not send it working unchanged.
--   2. chunks.member_chunk_ids: lineage for summary chunks, recording exactly
--      which chunks were folded into a summary. Compaction archives members
--      rather than deleting them, so this makes a summary auditable.

-- ─── Conversation identity on sessions ───────────────────────────────────────
ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS conversation_id text NOT NULL DEFAULT '';

-- Compaction groups by (organization, conversation) and orders by recency, so
-- the partial index covers exactly the rows the grouping query scans.
CREATE INDEX IF NOT EXISTS sessions_conversation_idx
    ON sessions (organization_id, conversation_id, updated_at)
    WHERE conversation_id <> '';

-- ─── Summary lineage on chunks ───────────────────────────────────────────────
ALTER TABLE chunks
    ADD COLUMN IF NOT EXISTS member_chunk_ids uuid[] NOT NULL DEFAULT '{}';

-- Compaction repeatedly asks "does this session already have a summary?" and
-- "which summaries are candidates for topic consolidation?". Both filter on
-- type, so index the summary types only; 'discussion' is the bulk of the table
-- and never matches these queries.
CREATE INDEX IF NOT EXISTS chunks_summary_type_idx
    ON chunks (organization_id, type, created_at)
    WHERE type IN ('summary', 'conversation_summary', 'topic_summary');
