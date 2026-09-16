package compaction

// consolidate.go implements the grouping levels of compaction: conversations
// first (the batches of one discussion), then topics (several conversations that
// covered the same subject). Both reuse summarizeAndArchive, which is the single
// place that writes a summary and retires the chunks it replaced.

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/google/uuid"

	"github.com/mihaibalaci/synapse/internal/ingestion"
	"github.com/mihaibalaci/synapse/internal/storage"
)

// ─── Prompts ─────────────────────────────────────────────────────────────────

const sessionSummarySystemPrompt = `You are a technical knowledge summarizer. Given a set of conversation chunks from a software engineering session, produce a concise summary that preserves:
- Key decisions and their reasoning
- Technical patterns and constraints discovered
- Action items and open questions
Keep the summary factual and under 500 words. Do not invent information not present in the chunks.`

const conversationSummarySystemPrompt = `You are a technical knowledge summarizer. The chunks below are consecutive parts of ONE conversation that was captured in several batches, in chronological order. Consolidate them into a single account of that conversation, preserving:
- Key decisions and their reasoning, and the final decision when it changed mid-conversation
- Technical patterns and constraints discovered
- Action items and open questions left unresolved
Where later parts supersede earlier ones, state the outcome and note that it changed. Do not repeat the same decision twice. Keep it factual and under 600 words. Do not invent information not present in the chunks.`

const topicSummarySystemPrompt = `You are a technical knowledge summarizer. The summaries below come from SEPARATE conversations that covered the same topic. Produce one consolidated topic summary that preserves:
- The current conclusions, and the reasoning behind them
- Agreements and disagreements between the conversations, including which position prevailed and when
- Recurring patterns, constraints, and pitfalls
- Open questions that remain across all of them
Prefer newer information when sources conflict, and say so explicitly instead of silently dropping the older view. Keep it factual and under 700 words. Do not invent information not present in the sources.`

// ─── Shared summarize-and-replace ────────────────────────────────────────────

// chunkRef is a chunk taking part in a consolidation.
type chunkRef struct {
	id         string
	title      string
	content    string
	tokenCount int
	authorID   string
}

// summarizeRequest describes one consolidation unit: the chunks to fold up, and
// where the resulting summary belongs.
type summarizeRequest struct {
	orgID string
	// attachSessionID owns the new summary chunk. chunks.session_id is NOT NULL,
	// so a conversation- or topic-level summary is attached to its earliest
	// contributing session.
	attachSessionID string
	chunkType       string
	title           string
	system          string
	members         []chunkRef
	// counter is the per-level tally in Result to increment on success.
	counter *int
}

// promptCharBudget bounds the characters sent to the LLM before compression.
const promptCharBudget = 12000

// summarizeAndArchive summarizes the members, inserts the summary, and marks the
// members archived in one transaction. The LLM and embedding calls happen before
// the transaction opens, so a failure there leaves the originals untouched and
// the group is simply retried on the next run.
func summarizeAndArchive(
	ctx context.Context,
	db *storage.DB,
	embedder *ingestion.EmbeddingClient,
	cfg Config,
	req summarizeRequest,
	result *Result,
) error {
	if len(req.members) == 0 {
		return nil
	}

	rawContent := buildPrompt(req.members)

	// COST OPTIMIZATION: Compress context before sending to LLM (30-60% token reduction)
	compressedContent := CompressForLLM(rawContent, 8000)
	tokensSavedByCompression := int64(len(rawContent)/4 - len(compressedContent)/4)

	summary, err := callLLM(ctx, cfg, req.system, compressedContent)
	if err != nil {
		return fmt.Errorf("LLM summarize: %w", err)
	}
	summary = strings.TrimSpace(summary)
	if summary == "" {
		return fmt.Errorf("LLM returned empty summary")
	}

	embedding, err := embedder.Embed(ctx, summary)
	if err != nil {
		return fmt.Errorf("embed summary: %w", err)
	}

	memberIDs := make([]string, len(req.members))
	var totalTokens int64
	for i, m := range req.members {
		memberIDs[i] = m.id
		totalTokens += int64(m.tokenCount)
	}

	poolTx, err := db.Pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin compact tx: %w", err)
	}
	defer poolTx.Rollback(ctx)

	summaryID := uuid.NewString()
	if _, err := poolTx.Exec(ctx, `
		INSERT INTO chunks (id, session_id, title, summary, content, token_count, type,
			author_id, organization_id, embedding, embedding_model, searchable_status,
			confidence, quality_score, member_chunk_ids)
		VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9::vector, $10, 'searchable',
			'high', 0.9, $11::uuid[])`,
		summaryID, req.attachSessionID, req.title, summary,
		estimateTokens(summary), req.chunkType,
		req.members[0].authorID, req.orgID,
		storage.VectorParam(embedding), embedder.Model(),
		memberIDs,
	); err != nil {
		return fmt.Errorf("insert %s: %w", req.chunkType, err)
	}

	// Retire the inputs. They keep their content and remain reachable through
	// member_chunk_ids; retrieval simply stops ranking them.
	if _, err := poolTx.Exec(ctx, `
		UPDATE chunks SET confidence = 'archived', updated_at = NOW()
		WHERE id = ANY($1::uuid[])`, memberIDs); err != nil {
		return fmt.Errorf("archive chunks: %w", err)
	}

	if err := poolTx.Commit(ctx); err != nil {
		return fmt.Errorf("commit compaction: %w", err)
	}

	if req.counter != nil {
		*req.counter++
	}
	result.ChunksArchived += len(req.members)
	result.SummariesCreated++
	result.TokensSaved += totalTokens - int64(estimateTokens(summary)) + tokensSavedByCompression
	return nil
}

// buildPrompt renders the members within a fixed character budget. Every member
// gets an equal share instead of the prompt being filled first-come: all members
// are archived once the summary is written, so a member absent from the prompt
// would be retired without ever being represented in what replaced it.
func buildPrompt(members []chunkRef) string {
	share := promptCharBudget / len(members)
	if share < 400 {
		share = 400
	}

	var b strings.Builder
	for i, m := range members {
		fmt.Fprintf(&b, "--- Part %d: %s ---\n%s\n\n", i+1, m.title, truncate(m.content, share))
	}
	return b.String()
}

// truncate cuts text to at most limit bytes without splitting a UTF-8 rune.
func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8Start(text[cut]) {
		cut--
	}
	return text[:cut] + "\n... (truncated)"
}

// utf8Start reports whether b begins a UTF-8 rune (i.e. is not a continuation
// byte, which always matches 0b10xxxxxx).
func utf8Start(b byte) bool { return b&0xC0 != 0x80 }

// shortID renders an identifier prefix for summary titles without assuming the
// id is long enough to slice.
func shortID(id string) string {
	if len(id) <= 8 {
		return id
	}
	return id[:8]
}

// loadActiveChunks reads the non-archived chunks of the given sessions in the
// order the conversation actually happened.
//
// Ordering is by capture time first and chunk insertion time second. Batches of
// one conversation are ingested asynchronously and can finish out of order, so
// chunks.created_at alone would reorder a conversation whose second batch was
// indexed before its first.
func loadActiveChunks(ctx context.Context, db *storage.DB, sessionIDs []string) ([]chunkRef, error) {
	rows, err := db.Query(ctx, `
		SELECT c.id, c.title, c.content, c.token_count, c.author_id
		FROM chunks c
		JOIN sessions s ON s.id = c.session_id
		WHERE c.session_id = ANY($1::uuid[])
		  AND c.confidence <> 'archived'
		ORDER BY s.started_at ASC, s.created_at ASC, c.created_at ASC`, sessionIDs)
	if err != nil {
		return nil, fmt.Errorf("load chunks: %w", err)
	}
	defer rows.Close()

	var members []chunkRef
	for rows.Next() {
		var c chunkRef
		if err := rows.Scan(&c.id, &c.title, &c.content, &c.tokenCount, &c.authorID); err != nil {
			return nil, fmt.Errorf("scan chunk: %w", err)
		}
		members = append(members, c)
	}
	return members, rows.Err()
}

// ─── Level 1: conversations ──────────────────────────────────────────────────

// conversationGroup is one logical conversation captured across several batches.
type conversationGroup struct {
	orgID          string
	conversationID string
	sessionIDs     []string
}

// compactConversations consolidates the batches of each finished conversation
// into a single summary before any of those batches can be summarized on its
// own. A conversation is considered finished only when its most recent batch is
// older than MinAgeDays, so a conversation still being flushed is left alone.
func compactConversations(
	ctx context.Context,
	db *storage.DB,
	embedder *ingestion.EmbeddingClient,
	cfg Config,
	result *Result,
) error {
	rows, err := db.Query(ctx, `
		SELECT s.organization_id,
		       s.conversation_id,
		       array_agg(s.id::text ORDER BY s.started_at ASC, s.created_at ASC) AS session_ids
		FROM sessions s
		WHERE s.conversation_id <> ''
		  AND s.searchable_status = 'searchable'
		  AND ($2 = 'all' OR s.organization_id = $2)
		  AND NOT EXISTS (
		    SELECT 1 FROM chunks c
		    WHERE c.session_id = s.id
		      AND c.type IN ('summary', 'conversation_summary', 'topic_summary')
		  )
		GROUP BY s.organization_id, s.conversation_id
		HAVING count(*) >= 2
		   AND max(s.updated_at) < NOW() - make_interval(days => $1::int)
		ORDER BY max(s.updated_at) ASC
		LIMIT $3`,
		cfg.MinAgeDays, cfg.orgFilter(), cfg.MaxPerRun)
	if err != nil {
		return fmt.Errorf("find conversation candidates: %w", err)
	}

	var groups []conversationGroup
	for rows.Next() {
		var g conversationGroup
		if err := rows.Scan(&g.orgID, &g.conversationID, &g.sessionIDs); err != nil {
			rows.Close()
			return fmt.Errorf("scan conversation candidate: %w", err)
		}
		groups = append(groups, g)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return fmt.Errorf("read conversation candidates: %w", err)
	}

	slog.Info("Conversation compaction candidates found", "count", len(groups))

	for _, g := range groups {
		if ctx.Err() != nil {
			break
		}
		if err := compactConversation(ctx, db, embedder, cfg, g, result); err != nil {
			slog.Warn("Compaction failed for conversation",
				"conversation", g.conversationID, "sessions", len(g.sessionIDs), "error", err)
			result.Errors++
		}
	}
	return nil
}

func compactConversation(
	ctx context.Context,
	db *storage.DB,
	embedder *ingestion.EmbeddingClient,
	cfg Config,
	g conversationGroup,
	result *Result,
) error {
	members, err := loadActiveChunks(ctx, db, g.sessionIDs)
	if err != nil {
		return err
	}
	// Two chunks is already worth merging here: the point is to reunite batches
	// that were split apart, even when each batch is small.
	if len(members) < 2 {
		return nil
	}

	return summarizeAndArchive(ctx, db, embedder, cfg, summarizeRequest{
		orgID:           g.orgID,
		attachSessionID: g.sessionIDs[0],
		chunkType:       TypeConversationSummary,
		title: fmt.Sprintf("Conversation summary: %s (%d batches)",
			displayConversationID(g.conversationID), len(g.sessionIDs)),
		system:  conversationSummarySystemPrompt,
		members: members,
		counter: &result.ConversationsCompacted,
	}, result)
}

// displayConversationID strips the developer namespace that the capture handler
// prepends, keeping summary titles readable.
func displayConversationID(id string) string {
	if i := strings.Index(id, ":"); i >= 0 && i+1 < len(id) {
		id = id[i+1:]
	}
	return shortID(id)
}

// ─── Level 3: topics ─────────────────────────────────────────────────────────

// summaryRef is a summary chunk that is a candidate for topic consolidation.
type summaryRef struct {
	chunkRef
	sessionID string
	// topicKey identifies the conversation a summary speaks for, so a group can
	// require coverage of genuinely different conversations.
	topicKey string
}

// compactTopics merges summaries from different conversations that cover the
// same subject. It runs after conversation consolidation so that each topic
// member already represents a whole conversation rather than one batch.
//
// Grouping is greedy nearest-neighbor over the summary embeddings: the oldest
// unused summary seeds a group, everything within TopicSimilarity joins it, and
// the group is merged when it spans at least TopicMinConversations distinct
// conversations. Members are only considered once they are TopicMinAgeDays old,
// so a conversation summary is retrievable on its own before being folded up.
func compactTopics(
	ctx context.Context,
	db *storage.DB,
	embedder *ingestion.EmbeddingClient,
	cfg Config,
	result *Result,
) error {
	orgs, err := topicOrganizations(ctx, db, cfg)
	if err != nil {
		return err
	}

	for _, orgID := range orgs {
		if ctx.Err() != nil {
			return nil
		}
		if err := compactTopicsForOrg(ctx, db, embedder, cfg, orgID, result); err != nil {
			slog.Warn("Topic compaction failed for organization", "organization", orgID, "error", err)
			result.Errors++
		}
	}
	return nil
}

// topicOrganizations lists the organizations that currently hold eligible
// summaries, so the similarity search never crosses a tenant boundary.
func topicOrganizations(ctx context.Context, db *storage.DB, cfg Config) ([]string, error) {
	rows, err := db.Query(ctx, `
		SELECT DISTINCT organization_id
		FROM chunks
		WHERE type IN ('summary', 'conversation_summary')
		  AND confidence <> 'archived'
		  AND searchable_status = 'searchable'
		  AND embedding IS NOT NULL
		  AND created_at < NOW() - make_interval(days => $1::int)
		  AND ($2 = 'all' OR organization_id = $2)`,
		cfg.TopicMinAgeDays, cfg.orgFilter())
	if err != nil {
		return nil, fmt.Errorf("find topic organizations: %w", err)
	}
	defer rows.Close()

	var orgs []string
	for rows.Next() {
		var org string
		if err := rows.Scan(&org); err != nil {
			return nil, fmt.Errorf("scan topic organization: %w", err)
		}
		orgs = append(orgs, org)
	}
	return orgs, rows.Err()
}

func compactTopicsForOrg(
	ctx context.Context,
	db *storage.DB,
	embedder *ingestion.EmbeddingClient,
	cfg Config,
	orgID string,
	result *Result,
) error {
	seeds, err := topicCandidates(ctx, db, cfg, orgID)
	if err != nil {
		return err
	}

	used := make(map[string]bool, len(seeds))
	clusters := 0

	for _, seed := range seeds {
		if ctx.Err() != nil || clusters >= cfg.TopicMaxClusters {
			break
		}
		if used[seed.id] {
			continue
		}

		neighbors, err := topicNeighbors(ctx, db, cfg, orgID, seed, used)
		if err != nil {
			return err
		}

		group := append([]summaryRef{seed}, neighbors...)
		if countTopics(group) < cfg.TopicMinConversations {
			// Nothing similar enough yet. Mark the seed used so it is not
			// reconsidered as a neighbor of itself later in this pass; a future
			// run reconsiders it once more summaries exist.
			used[seed.id] = true
			continue
		}

		members := make([]chunkRef, len(group))
		for i, s := range group {
			members[i] = s.chunkRef
		}

		req := summarizeRequest{
			orgID:           orgID,
			attachSessionID: seed.sessionID,
			chunkType:       TypeTopicSummary,
			title: fmt.Sprintf("Topic summary: %s (%d conversations)",
				topicTitle(seed.title), countTopics(group)),
			system:  topicSummarySystemPrompt,
			members: members,
			counter: &result.TopicsCompacted,
		}
		if err := summarizeAndArchive(ctx, db, embedder, cfg, req, result); err != nil {
			slog.Warn("Topic compaction failed", "seed", seed.id, "error", err)
			result.Errors++
			used[seed.id] = true
			continue
		}

		for _, s := range group {
			used[s.id] = true
		}
		clusters++
	}
	return nil
}

// topicCandidates returns eligible summaries oldest first, so consolidation
// starts from the settled material.
func topicCandidates(ctx context.Context, db *storage.DB, cfg Config, orgID string) ([]summaryRef, error) {
	rows, err := db.Query(ctx, `
		SELECT c.id, c.title, c.content, c.token_count, c.author_id, c.session_id::text,
		       CASE WHEN s.conversation_id <> '' THEN s.conversation_id ELSE c.session_id::text END
		FROM chunks c
		JOIN sessions s ON s.id = c.session_id
		WHERE c.organization_id = $1
		  AND c.type IN ('summary', 'conversation_summary')
		  AND c.confidence <> 'archived'
		  AND c.searchable_status = 'searchable'
		  AND c.embedding IS NOT NULL
		  AND c.created_at < NOW() - make_interval(days => $2::int)
		ORDER BY c.created_at ASC
		LIMIT $3`,
		orgID, cfg.TopicMinAgeDays, cfg.TopicMaxClusters*10)
	if err != nil {
		return nil, fmt.Errorf("find topic candidates: %w", err)
	}
	defer rows.Close()

	var out []summaryRef
	for rows.Next() {
		var s summaryRef
		if err := rows.Scan(&s.id, &s.title, &s.content, &s.tokenCount, &s.authorID,
			&s.sessionID, &s.topicKey); err != nil {
			return nil, fmt.Errorf("scan topic candidate: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// topicNeighbors finds the summaries similar enough to the seed to belong to the
// same topic, excluding anything already consumed by an earlier group.
func topicNeighbors(
	ctx context.Context,
	db *storage.DB,
	cfg Config,
	orgID string,
	seed summaryRef,
	used map[string]bool,
) ([]summaryRef, error) {
	excluded := make([]string, 0, len(used)+1)
	excluded = append(excluded, seed.id)
	for id := range used {
		excluded = append(excluded, id)
	}

	rows, err := db.Query(ctx, `
		SELECT c.id, c.title, c.content, c.token_count, c.author_id, c.session_id::text,
		       CASE WHEN s.conversation_id <> '' THEN s.conversation_id ELSE c.session_id::text END
		FROM chunks c
		JOIN sessions s ON s.id = c.session_id
		WHERE c.organization_id = $1
		  AND c.type IN ('summary', 'conversation_summary')
		  AND c.confidence <> 'archived'
		  AND c.searchable_status = 'searchable'
		  AND c.embedding IS NOT NULL
		  AND c.created_at < NOW() - make_interval(days => $2::int)
		  AND c.id <> ALL($3::uuid[])
		  AND 1 - (c.embedding <=> (SELECT embedding FROM chunks WHERE id = $4)) >= $5::float8
		ORDER BY c.embedding <=> (SELECT embedding FROM chunks WHERE id = $4)
		LIMIT 20`,
		orgID, cfg.TopicMinAgeDays, excluded, seed.id, cfg.TopicSimilarity)
	if err != nil {
		return nil, fmt.Errorf("find topic neighbors: %w", err)
	}
	defer rows.Close()

	var out []summaryRef
	for rows.Next() {
		var s summaryRef
		if err := rows.Scan(&s.id, &s.title, &s.content, &s.tokenCount, &s.authorID,
			&s.sessionID, &s.topicKey); err != nil {
			return nil, fmt.Errorf("scan topic neighbor: %w", err)
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// countTopics counts the distinct conversations a group covers. A topic summary
// is only justified when it spans more than one conversation; several summaries
// from the same conversation are level 1's job.
func countTopics(group []summaryRef) int {
	seen := make(map[string]bool, len(group))
	for _, s := range group {
		seen[s.topicKey] = true
	}
	return len(seen)
}

// reLevelSuffix matches the member count compaction appends to a summary title,
// so a higher level does not inherit the lower level's tally.
var reLevelSuffix = regexp.MustCompile(`\s*\(\d+ (batches|conversations)\)$`)

// topicTitle derives a topic label from the seed summary's title, dropping the
// level prefix and member count that compaction itself added.
func topicTitle(title string) string {
	for _, prefix := range []string{"Conversation summary: ", "Summary: ", "Topic summary: "} {
		title = strings.TrimPrefix(title, prefix)
	}
	title = reLevelSuffix.ReplaceAllString(title, "")
	title = strings.TrimSpace(title)
	if title == "" {
		return "untitled"
	}
	return clip(title, 80)
}

// clip shortens a single-line label without the multi-line marker truncate adds.
func clip(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	cut := limit
	for cut > 0 && !utf8Start(text[cut]) {
		cut--
	}
	return strings.TrimSpace(text[:cut]) + "…"
}
