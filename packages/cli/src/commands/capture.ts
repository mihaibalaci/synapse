import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { readFileSync } from 'node:fs';
import { api, getIdentity } from '../api-client.js';

export const captureCommand = new Command('capture')
  .description('Capture an AI session from a JSON file or stdin')
  .argument('[file]', 'Path to session JSON file (or pipe via stdin)')
  .option('-r, --repo <repository>', 'Repository context')
  .option('-t, --tags <tags...>', 'Tags for categorization')
  .option('-a, --annotation <text>', 'Why this session is valuable')
  .option('--promote', 'Force Tier 2 deep processing')
  .action(async (file: string | undefined, opts) => {
    const spinner = ora('Capturing session...').start();
    const { developerId, organizationId } = getIdentity();

    try {
      let content: string;
      if (file) {
        content = readFileSync(file, 'utf-8');
      } else {
        // Read from stdin
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        content = Buffer.concat(chunks).toString('utf-8');
      }

      const session = JSON.parse(content);

      // Detect format: either our schema or simple messages array
      const messages = session.messages ?? session;
      if (!Array.isArray(messages)) {
        throw new Error('Input must be a JSON array of messages or a session object with a "messages" field');
      }

      const result = await api('/api/v1/capture/active', 'POST', {
        clientId: crypto.randomUUID(),
        developerId,
        organizationId,
        messages: messages.map((m: any, i: number) => ({
          id: crypto.randomUUID(),
          role: m.role ?? 'user',
          content: m.content ?? m.text ?? String(m),
          codeBlocks: [],
          timestamp: m.timestamp ?? new Date().toISOString(),
          tokenCount: Math.ceil((m.content ?? '').length / 4),
          toolCalls: [],
        })),
        metadata: {
          project: opts.repo?.split('/').pop() ?? 'unknown',
          language: 'unknown',
          languages: [],
          frameworks: [],
          aiProvider: 'custom',
          aiModel: 'unknown',
          tags: opts.tags ?? [],
        },
        git: opts.repo ? { repository: opts.repo, branch: 'main', filesTouched: [], codeDiffs: [] } : undefined,
        startedAt: messages[0]?.timestamp ?? new Date().toISOString(),
        endedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
        totalTokens: messages.reduce((s: number, m: any) => s + Math.ceil((m.content ?? '').length / 4), 0),
        tags: opts.tags,
        annotation: opts.annotation,
        promoteTier2: opts.promote ?? false,
      });

      spinner.succeed(`Session captured: ${chalk.bold(result.sessionId)}`);
      console.log(chalk.dim(`  Mode: active | Tier: ${result.tier ?? 'auto'} | Messages: ${messages.length}`));
      if (opts.annotation) console.log(chalk.dim(`  Note: ${opts.annotation}`));
    } catch (error: any) {
      spinner.fail(error.message);
      process.exit(1);
    }
  });
