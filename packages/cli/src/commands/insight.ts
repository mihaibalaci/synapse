import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { api, getIdentity } from '../api-client.js';

export const insightCommand = new Command('insight')
  .description('Store a quick insight or fact to the knowledge base')
  .argument('<text...>', 'The insight/fact to store')
  .option('-t, --type <type>', 'Fact type (decision, lesson, pattern, constraint, procedure)', 'lesson')
  .option('-r, --repo <repository>', 'Related repository')
  .action(async (textParts: string[], opts) => {
    const text = textParts.join(' ');
    const spinner = ora('Saving insight...').start();
    const { developerId, organizationId } = getIdentity();

    try {
      const result = await api('/api/v1/capture/passive', 'POST', {
        messages: [
          { role: 'user', content: `Record this ${opts.type}: ${text}` },
          { role: 'assistant', content: text },
        ],
        source: 'cli',
        repository: opts.repo,
        developerId,
        organizationId,
      });

      spinner.succeed(`Insight saved: ${chalk.italic(text)}`);
      console.log(chalk.dim(`  Type: ${opts.type} | Session: ${result.sessionId}`));
    } catch (error: any) {
      spinner.fail(error.message);
      process.exit(1);
    }
  });
