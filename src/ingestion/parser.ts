/**
 * Session Parser
 *
 * Normalizes raw AI session data from different providers into a
 * uniform structure. Each provider (Claude, GPT, Copilot, Cursor, etc.)
 * has slightly different formats — the parser handles these differences.
 *
 * Output: A normalized conversation with typed messages, extracted
 * code blocks, and identified metadata.
 */

import { v4 as uuidv4 } from 'uuid';
import { createChildLogger } from '../utils/logger.js';
import {
  type SessionRecord,
  type Message,
  type CodeBlock,
  type AIProvider,
} from '../models/index.js';

const logger = createChildLogger({ module: 'parser' });

// ─── Parsed Output ───────────────────────────────────────────────────────────

export interface ParsedSession {
  sessionId: string;
  messages: ParsedMessage[];
  totalTokens: number;
  languages: string[];
  frameworks: string[];
  topics: string[];           // High-level topic hints extracted during parsing
}

export interface ParsedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  codeBlocks: CodeBlock[];
  timestamp: string;
  tokenCount: number;
  /** Index in the original conversation (for ordering) */
  index: number;
}

// ─── Parser ──────────────────────────────────────────────────────────────────

export class SessionParser {
  /**
   * Parse a raw session into normalized messages.
   * Handles provider-specific quirks and extracts code blocks.
   */
  async parse(session: SessionRecord): Promise<ParsedSession> {
    logger.info({
      sessionId: session.id,
      provider: session.metadata.aiProvider,
      messageCount: session.messages.length,
    }, 'Parsing session');

    const messages: ParsedMessage[] = [];
    const languageSet = new Set<string>();
    const frameworkSet = new Set<string>();

    for (let i = 0; i < session.messages.length; i++) {
      const raw = session.messages[i];
      const parsed = this.parseMessage(raw, i, session.metadata.aiProvider);
      messages.push(parsed);

      // Collect languages from code blocks
      for (const block of parsed.codeBlocks) {
        if (block.language && block.language !== 'text' && block.language !== 'plaintext') {
          languageSet.add(block.language.toLowerCase());
        }
      }
    }

    // Add session-level languages/frameworks
    if (session.metadata.language) languageSet.add(session.metadata.language.toLowerCase());
    for (const lang of session.metadata.languages) languageSet.add(lang.toLowerCase());
    for (const fw of session.metadata.frameworks) frameworkSet.add(fw.toLowerCase());

    // Extract framework hints from content
    const detectedFrameworks = this.detectFrameworks(messages);
    for (const fw of detectedFrameworks) frameworkSet.add(fw);

    // Extract high-level topic hints
    const topics = this.extractTopicHints(messages);

    const result: ParsedSession = {
      sessionId: session.id,
      messages,
      totalTokens: messages.reduce((sum, m) => sum + m.tokenCount, 0),
      languages: [...languageSet],
      frameworks: [...frameworkSet],
      topics,
    };

    logger.info({
      sessionId: session.id,
      parsedMessages: messages.length,
      languages: result.languages,
      topics: result.topics.length,
    }, 'Session parsed');

    return result;
  }

  /**
   * Parse a single message, extracting code blocks and normalizing content.
   */
  private parseMessage(message: Message, index: number, provider: AIProvider): ParsedMessage {
    // Extract code blocks from markdown fences
    const codeBlocks = this.extractCodeBlocks(message.content);

    // Merge with any pre-identified code blocks from the upload
    const allCodeBlocks = [...message.codeBlocks, ...codeBlocks];

    // Deduplicate code blocks by content
    const uniqueBlocks = this.deduplicateCodeBlocks(allCodeBlocks);

    return {
      id: message.id ?? uuidv4(),
      role: message.role,
      content: message.content,
      codeBlocks: uniqueBlocks,
      timestamp: message.timestamp,
      tokenCount: message.tokenCount || this.estimateTokens(message.content),
      index,
    };
  }

  /**
   * Extract fenced code blocks from markdown content.
   * Handles ```language\n...\n``` patterns.
   */
  private extractCodeBlocks(content: string): CodeBlock[] {
    const blocks: CodeBlock[] = [];
    const regex = /```(\w*)\n([\s\S]*?)```/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      const language = match[1] || 'text';
      const code = match[2].trim();

      if (code.length > 10) { // Skip trivially small blocks
        blocks.push({
          language,
          content: code,
          filePath: this.inferFilePath(code, language),
        });
      }
    }

    return blocks;
  }

  /**
   * Try to infer file path from code content (e.g., import statements, comments).
   */
  private inferFilePath(code: string, language: string): string | undefined {
    // Check for file path comments (common in AI responses)
    const filePathComment = code.match(/^\/\/\s*([\w/.-]+\.\w+)/m)
      ?? code.match(/^#\s*([\w/.-]+\.\w+)/m)
      ?? code.match(/^\/\*\s*([\w/.-]+\.\w+)/m);

    if (filePathComment) return filePathComment[1];
    return undefined;
  }

  /**
   * Detect frameworks mentioned in the conversation.
   */
  private detectFrameworks(messages: ParsedMessage[]): string[] {
    const fullText = messages.map(m => m.content).join(' ').toLowerCase();
    const frameworks: string[] = [];

    const frameworkPatterns: Array<[string, RegExp]> = [
      ['react', /\breact\b/],
      ['nextjs', /\bnext\.?js\b/],
      ['express', /\bexpress\b/],
      ['fastify', /\bfastify\b/],
      ['django', /\bdjango\b/],
      ['flask', /\bflask\b/],
      ['spring', /\bspring\s?(boot)?\b/],
      ['terraform', /\bterraform\b/],
      ['cdk', /\b(aws\s)?cdk\b/],
      ['docker', /\bdocker\b/],
      ['kubernetes', /\bkubernetes\b|\bk8s\b/],
      ['redux', /\bredux\b/],
      ['vue', /\bvue\.?js?\b/],
      ['angular', /\bangular\b/],
      ['svelte', /\bsvelte\b/],
      ['tailwind', /\btailwind\b/],
      ['prisma', /\bprisma\b/],
      ['graphql', /\bgraphql\b/],
      ['aws-lambda', /\blambda\b.*\baws\b|\baws\b.*\blambda\b/],
    ];

    for (const [name, pattern] of frameworkPatterns) {
      if (pattern.test(fullText)) {
        frameworks.push(name);
      }
    }

    return frameworks;
  }

  /**
   * Extract high-level topic hints from user messages.
   * These help the segmenter identify conversation boundaries.
   */
  private extractTopicHints(messages: ParsedMessage[]): string[] {
    const topics: string[] = [];
    const userMessages = messages.filter(m => m.role === 'user');

    for (const msg of userMessages) {
      // Short user messages often indicate a new topic
      if (msg.content.length < 200) {
        const cleaned = msg.content.replace(/```[\s\S]*?```/g, '').trim();
        if (cleaned.length > 10 && cleaned.length < 150) {
          topics.push(cleaned);
        }
      }
    }

    return topics;
  }

  /**
   * Remove duplicate code blocks (same content, possibly different metadata).
   */
  private deduplicateCodeBlocks(blocks: CodeBlock[]): CodeBlock[] {
    const seen = new Set<string>();
    return blocks.filter(block => {
      const key = block.content.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Rough token estimation (4 chars ≈ 1 token for English text).
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}
