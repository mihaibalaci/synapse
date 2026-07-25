#!/usr/bin/env node
/**
 * Recall — MCP Server
 *
 * Exposes the knowledge base as MCP tools that any AI agent can use.
 * Works with Claude Desktop, Cursor, Kiro, Windsurf, Cline, and any
 * MCP-compatible client.
 *
 * Tools provided:
 *   - search_knowledge: Semantic search across org knowledge
 *   - get_context: Get relevant context for current coding task
 *   - get_facts: Query atomic facts by entity/time
 *   - get_fact_history: See how knowledge evolved over time
 *   - save_session: Capture the current AI session to the knowledge base
 *   - save_insight: Store a single atomic fact/insight
 *
 * Configuration via environment variables:
 *   RECALL_API_URL  — API base URL (default: http://localhost:3000)
 *   RECALL_TOKEN — Bearer token for auth
 *   DEVELOPER_ID — Current developer identity
 *   ORGANIZATION_ID — Organization scope
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ─── Configuration ───────────────────────────────────────────────────────────

const BASE_URL = process.env.RECALL_API_URL ?? 'http://localhost:3000';
const TOKEN = process.env.RECALL_TOKEN ?? '';
const DEVELOPER_ID = process.env.DEVELOPER_ID ?? 'unknown';
const ORGANIZATION_ID = process.env.ORGANIZATION_ID ?? 'default';

// ─── API Client ──────────────────────────────────────────────────────────────

async function apiCall(path: string, method: string, body?: unknown): Promise<any> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API ${method} ${path} failed: ${response.status} ${text}`);
  }

  return response.json();
}

// ─── MCP Server ──────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'recall',
  version: '0.1.0',
});

// ─── Tool: search_knowledge ──────────────────────────────────────────────────

server.tool(
  'search_knowledge',
  'Search the engineering knowledge base. Returns relevant chunks from past AI sessions, debugging insights, architecture decisions, and best practices across the organization.',
  {
    query: z.string().describe('Natural language search query'),
    repository: z.string().optional().describe('Filter by repository (e.g. "org/service-name")'),
    language: z.string().optional().describe('Filter by programming language'),
    maxResults: z.number().optional().default(5).describe('Maximum number of results (1-20)'),
  },
  async ({ query, repository, language, maxResults }) => {
    const result = await apiCall('/api/v1/search', 'POST', {
      query,
      context: { repository, language },
      filters: {
        repositories: repository ? [repository] : undefined,
        languages: language ? [language] : undefined,
      },
      topK: Math.min(maxResults ?? 5, 20),
      strategy: 'hybrid',
      includeContent: true,
      developerId: DEVELOPER_ID,
      organizationId: ORGANIZATION_ID,
    });

    if (!result.results || result.results.length === 0) {
      return { content: [{ type: 'text', text: 'No relevant knowledge found for this query.' }] };
    }

    const formatted = result.results.map((r: any, i: number) =>
      `## ${i + 1}. ${r.title} (score: ${r.finalScore.toFixed(2)})\n` +
      `${r.summary}\n\n${r.content ?? ''}\n` +
      (r.codeSnippets?.length ? `\`\`\`${r.codeSnippets[0].language}\n${r.codeSnippets[0].code}\n\`\`\`\n` : '') +
      `_Source: ${r.citations?.[0]?.reference ?? 'unknown'} | ${r.repository ?? ''} | ${r.createdAt?.substring(0, 10) ?? ''}_`
    ).join('\n\n---\n\n');

    return {
      content: [{
        type: 'text',
        text: `Found ${result.totalCount} results (showing top ${result.results.length}, ${result.estimatedTokens} tokens):\n\n${formatted}`,
      }],
    };
  },
);

// ─── Tool: get_context ───────────────────────────────────────────────────────

server.tool(
  'get_context',
  'Get relevant context for the current coding task. Use this before answering coding questions to check if the organization already has knowledge about this topic. Returns concise, ranked context optimized for token budget.',
  {
    query: z.string().describe('What you need context about'),
    repository: z.string().optional().describe('Current repository'),
    filePath: z.string().optional().describe('Current file being edited'),
    language: z.string().optional().describe('Programming language'),
    maxTokens: z.number().optional().default(3000).describe('Token budget for returned context'),
  },
  async ({ query, repository, filePath, language, maxTokens }) => {
    const result = await apiCall('/api/v1/context', 'POST', {
      query,
      repository,
      filePath,
      language,
      maxTokens: maxTokens ?? 3000,
      developerId: DEVELOPER_ID,
      organizationId: ORGANIZATION_ID,
    });

    if (!result.context || result.context.length === 0) {
      return { content: [{ type: 'text', text: 'No existing organizational context found for this topic.' }] };
    }

    const formatted = result.context.map((c: any) =>
      `### ${c.title}\n${c.content}`
    ).join('\n\n---\n\n');

    return {
      content: [{
        type: 'text',
        text: `Organization context (${result.estimatedTokens} tokens, ${result.returnedResults} results):\n\n${formatted}`,
      }],
    };
  },
);

// ─── Tool: get_facts ─────────────────────────────────────────────────────────

server.tool(
  'get_facts',
  'Query atomic facts from the knowledge base. Facts are concise, verified statements like "Team uses Kafka for event streaming" or "Lambda timeout caused by VPC DNS". Great for quick lookups.',
  {
    entities: z.array(z.string()).optional().describe('Entities to search for (e.g. ["Kafka", "Lambda"])'),
    types: z.array(z.string()).optional().describe('Fact types: decision, preference, pattern, lesson, constraint, procedure, definition, relationship'),
    onlyValid: z.boolean().optional().default(true).describe('Only return currently-valid facts (exclude superseded)'),
    limit: z.number().optional().default(10).describe('Max facts to return'),
  },
  async ({ entities, types, onlyValid, limit }) => {
    const params = new URLSearchParams();
    if (entities?.length) params.set('entities', entities.join(','));
    if (types?.length) params.set('types', types.join(','));
    if (onlyValid !== undefined) params.set('onlyValid', String(onlyValid));
    params.set('limit', String(limit ?? 10));

    const result = await apiCall(`/api/v1/facts?${params}`, 'GET');

    if (!result.facts || result.facts.length === 0) {
      return { content: [{ type: 'text', text: 'No facts found matching the query.' }] };
    }

    const formatted = result.facts.map((f: any) =>
      `- **[${f.type}]** ${f.content} _(confidence: ${f.confidence}, used ${f.usageCount}x)_`
    ).join('\n');

    return {
      content: [{ type: 'text', text: `Found ${result.total} facts:\n\n${formatted}` }],
    };
  },
);

// ─── Tool: get_fact_history ──────────────────────────────────────────────────

server.tool(
  'get_fact_history',
  'See how knowledge about an entity evolved over time. Shows the temporal chain of facts, including superseded ones. Useful for understanding "when did we change X?" or "what was the old approach?"',
  {
    entity: z.string().describe('Entity to get history for (e.g. "Kafka", "auth-service", "PostgreSQL")'),
  },
  async ({ entity }) => {
    const result = await apiCall(`/api/v1/facts/${encodeURIComponent(entity)}/history`, 'GET');

    if (!result.history || result.history.length === 0) {
      return { content: [{ type: 'text', text: `No history found for entity "${entity}".` }] };
    }

    const formatted = result.history.map((f: any) => {
      const status = f.temporal.validUntil ? '~~superseded~~' : '**current**';
      const period = `${f.temporal.validFrom ?? '?'} → ${f.temporal.validUntil ?? 'now'}`;
      return `- ${status} [${period}] ${f.content}`;
    }).join('\n');

    return {
      content: [{ type: 'text', text: `History for "${entity}":\n\n${formatted}` }],
    };
  },
);

// ─── Tool: save_session ──────────────────────────────────────────────────────

server.tool(
  'save_session',
  'Save the current AI conversation to the organizational knowledge base. Use this when a conversation produces valuable insights, solves a tricky bug, or makes an important decision.',
  {
    messages: z.array(z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string(),
    })).describe('The conversation messages to save'),
    repository: z.string().optional().describe('Repository this conversation relates to'),
    language: z.string().optional().describe('Primary language discussed'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    annotation: z.string().optional().describe('Why this session is valuable'),
  },
  async ({ messages, repository, language, tags, annotation }) => {
    const result = await apiCall('/api/v1/capture/active', 'POST', {
      clientId: crypto.randomUUID(),
      developerId: DEVELOPER_ID,
      organizationId: ORGANIZATION_ID,
      messages: messages.map((m, i) => ({
        id: crypto.randomUUID(),
        role: m.role,
        content: m.content,
        codeBlocks: [],
        timestamp: new Date().toISOString(),
        tokenCount: Math.ceil(m.content.length / 4),
        toolCalls: [],
      })),
      metadata: {
        project: repository?.split('/').pop() ?? 'unknown',
        language: language ?? 'unknown',
        languages: language ? [language] : [],
        frameworks: [],
        aiProvider: 'custom',
        aiModel: 'unknown',
        tags: tags ?? [],
      },
      git: repository ? { repository, branch: 'main', filesTouched: [], codeDiffs: [] } : undefined,
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      totalTokens: messages.reduce((s, m) => s + Math.ceil(m.content.length / 4), 0),
      tags,
      annotation,
      promoteTier2: true,
    });

    return {
      content: [{
        type: 'text',
        text: `Session saved to knowledge base.\nID: ${result.sessionId}\nStatus: ${result.status}\nTier: ${result.tier ?? 'deep'}\n\nThis will be processed and made available for future retrieval.`,
      }],
    };
  },
);

// ─── Tool: save_insight ──────────────────────────────────────────────────────

server.tool(
  'save_insight',
  'Store a single atomic insight/fact to the knowledge base. Use this for quick captures like "We decided to use Kafka" or "The timeout was caused by VPC DNS resolution".',
  {
    content: z.string().describe('The fact or insight to store (one concise sentence)'),
    type: z.enum(['decision', 'preference', 'pattern', 'lesson', 'constraint', 'procedure', 'definition', 'relationship']).describe('Type of knowledge'),
    entities: z.array(z.string()).optional().describe('Key entities mentioned'),
    repository: z.string().optional().describe('Related repository'),
  },
  async ({ content, type, entities, repository }) => {
    // Save as a minimal session with just the insight
    const result = await apiCall('/api/v1/capture/passive', 'POST', {
      messages: [
        { role: 'user', content: `Record this ${type}: ${content}` },
        { role: 'assistant', content },
      ],
      source: 'mcp-tool',
      repository,
      developerId: DEVELOPER_ID,
      organizationId: ORGANIZATION_ID,
    });

    return {
      content: [{
        type: 'text',
        text: `Insight saved: "${content}"\nType: ${type}\nEntities: ${entities?.join(', ') ?? 'auto-detected'}\nSession: ${result.sessionId}`,
      }],
    };
  },
);

// ─── Start Server ────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error('MCP Server failed to start:', error);
  process.exit(1);
});
