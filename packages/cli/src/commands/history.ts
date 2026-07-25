import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { api } from '../api-client.js';

export const historyCommand = new Command('history')
  .description('View temporal evolution of knowledge about an entity')
  .argument('<entity>', 'Entity to get history for (e.g. "Kafka", "auth-service")')
  .option('--json', 'Output raw JSON')
  .action(async (entity: string, opts) => {
    const spinner = ora(`Loading history for "${entity}"...`).start();

    try {
      const result = await api(`/api/v1/facts/${encodeURIComponent(entity)}/history`, 'GET');
      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.history?.length) {
        console.log(chalk.yellow(`No history found for "${entity}".`));
        return;
      }

      console.log(chalk.bold(`History for "${entity}":\n`));

      for (const [i, f] of result.history.entries()) {
        const isCurrent = !f.temporal?.validUntil;
        const marker = isCurrent ? chalk.green('▶') : chalk.dim('○');
        const period = `${f.temporal?.validFrom?.substring(0, 10) ?? '?'} → ${f.temporal?.validUntil?.substring(0, 10) ?? 'now'}`;

        console.log(`  ${marker} ${chalk.dim(period)}`);
        console.log(`    ${isCurrent ? chalk.bold(f.content) : chalk.dim(f.content)}`);
        if (f.temporal?.supersededBy) {
          console.log(chalk.dim(`    └─ superseded by next entry`));
        }
        console.log('');
      }
    } catch (error: any) {
      spinner.fail(error.message);
      process.exit(1);
    }
  });
