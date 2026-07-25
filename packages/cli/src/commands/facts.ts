import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { api } from '../api-client.js';

export const factsCommand = new Command('facts')
  .description('Query atomic facts from the knowledge base')
  .option('-e, --entity <entities...>', 'Filter by entities')
  .option('-t, --type <types...>', 'Filter by type (decision, lesson, pattern, constraint, etc.)')
  .option('--all', 'Include superseded facts')
  .option('-n, --limit <number>', 'Max results', '15')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const spinner = ora('Querying facts...').start();

    try {
      const params = new URLSearchParams();
      if (opts.entity?.length) params.set('entities', opts.entity.join(','));
      if (opts.type?.length) params.set('types', opts.type.join(','));
      params.set('onlyValid', opts.all ? 'false' : 'true');
      params.set('limit', opts.limit);

      const result = await api(`/api/v1/facts?${params}`, 'GET');
      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.facts?.length) {
        console.log(chalk.yellow('No facts found.'));
        return;
      }

      console.log(chalk.dim(`${result.total} facts found:\n`));

      for (const f of result.facts) {
        const typeColor = f.type === 'decision' ? chalk.blue
          : f.type === 'lesson' ? chalk.magenta
          : f.type === 'pattern' ? chalk.green
          : f.type === 'constraint' ? chalk.red
          : chalk.white;

        const validity = f.temporal?.validUntil
          ? chalk.strikethrough.dim('superseded')
          : chalk.green('●');

        console.log(`  ${validity} ${typeColor(`[${f.type}]`)} ${f.content}`);
        console.log(chalk.dim(`     entities: ${f.entities?.join(', ') ?? '—'} | confidence: ${f.confidence} | used: ${f.usageCount}x`));
        console.log('');
      }
    } catch (error: any) {
      spinner.fail(error.message);
      process.exit(1);
    }
  });
