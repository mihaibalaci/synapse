import { describe, it, expect, beforeEach } from 'vitest';
import { SessionParser } from '../../src/ingestion/parser.js';

describe('SessionParser', () => {
  let parser: SessionParser;

  beforeEach(() => {
    parser = new SessionParser();
  });

  const mockSession: any = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    messages: [
      {
        id: '00000000-0000-0000-0000-000000000001',
        role: 'user',
        content: 'How do I optimize S3 uploads for large files?',
        codeBlocks: [],
        timestamp: '2025-07-25T10:00:00Z',
        tokenCount: 12,
        toolCalls: [],
      },
      {
        id: '00000000-0000-0000-0000-000000000002',
        role: 'assistant',
        content: 'Use multipart uploads for files larger than 100MB. Here is an example:\n\n```typescript\nconst upload = new Upload({\n  client: s3Client,\n  params: { Bucket: bucket, Key: key, Body: stream },\n  partSize: 1024 * 1024 * 10,\n});\nawait upload.done();\n```\n\nThis splits the file into 10MB chunks and uploads them in parallel.',
        codeBlocks: [],
        timestamp: '2025-07-25T10:00:05Z',
        tokenCount: 120,
        toolCalls: [],
      },
    ],
    metadata: {
      aiProvider: 'claude',
      language: 'typescript',
      languages: ['typescript'],
      frameworks: ['aws-sdk'],
    },
  };

  it('should parse a session into normalized messages', async () => {
    const result = await parser.parse(mockSession);

    expect(result.sessionId).toBe(mockSession.id);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe('user');
    expect(result.messages[1].role).toBe('assistant');
  });

  it('should extract code blocks from markdown fences', async () => {
    const result = await parser.parse(mockSession);

    const assistantMsg = result.messages[1];
    expect(assistantMsg.codeBlocks.length).toBeGreaterThanOrEqual(1);
    expect(assistantMsg.codeBlocks[0].language).toBe('typescript');
    expect(assistantMsg.codeBlocks[0].content).toContain('Upload');
  });

  it('should detect languages from code blocks', async () => {
    const result = await parser.parse(mockSession);

    expect(result.languages).toContain('typescript');
  });

  it('should detect frameworks mentioned in content', async () => {
    const session = {
      ...mockSession,
      messages: [
        ...mockSession.messages,
        {
          id: '00000000-0000-0000-0000-000000000003',
          role: 'user',
          content: 'Can I use this with React and Redux?',
          codeBlocks: [],
          timestamp: '2025-07-25T10:01:00Z',
          tokenCount: 10,
          toolCalls: [],
        },
      ],
    };

    const result = await parser.parse(session);
    expect(result.frameworks).toContain('react');
  });

  it('should extract topic hints from short user messages', async () => {
    const result = await parser.parse(mockSession);

    expect(result.topics.length).toBeGreaterThanOrEqual(1);
    expect(result.topics[0]).toContain('S3');
  });

  it('should estimate token count when not provided', async () => {
    const session = {
      ...mockSession,
      messages: [{
        ...mockSession.messages[0],
        tokenCount: 0, // Force estimation
      }],
    };

    const result = await parser.parse(session);
    expect(result.messages[0].tokenCount).toBeGreaterThan(0);
  });

  it('should handle empty messages gracefully', async () => {
    const session = { ...mockSession, messages: [] };
    // Should not throw
    const result = await parser.parse(session);
    expect(result.messages).toHaveLength(0);
  });
});
