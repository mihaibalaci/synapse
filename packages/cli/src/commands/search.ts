import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { api, getIdentity } from '../api-client.js';

export const searchCommand = new Command('search')
  .description('Search the engineering knowledge base')
  .argument('<query...>', 'Search query (natural language)')
  .option('-r, --repo <repository>', 'Filter by repository')
  .option('-l, --lang <language>', 'Filter by language')
  .option('-n, --limit <number>', 'Max results', '5')
  .option('--json', 'Output raw JSON')
  .action(async (queryParts: string[], opts) => {
    const query = queryParts.join(' ');
    const spinner = ora(`Searching: "${query}"`).start();
    const { developerId, organizationId } = getIdentity();

    try {
      const result = await api('/api/v1/search', 'POST', {
        query,
        context: { repository: opts.repo, language: opts.lang },
        filters: {
          repositories: opts.repo ? [opts.repo] : undefined,
          languages: opts.lang ? [opts.lang] : undefined,
        },
        topK: parseInt(opts.limit, 10),
        strategy: 'hybrid',
        includeContent: true,
        developerId,
        organizationId,
      });

      spinner.stop();

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (!result.results?.length) {
        console.log(chalk.yellow('No results found.'));
        return;
      }

      console.log(chalk.dim(`${result.totalCount} results (${result.latencyMs}ms, ~${result.estimatedTokens} tokens)\n`));

      for (const [i, r] of result.results.entries()) {
        const score = chalk.green(`${(r.finalScore * 100).toFixed(0)}%`);
        console.log(`${chalk.bold(`${i + 1}. ${r.title}`)} ${score}`);
        console.log(chalk.dim(`   ${r.repository ?? ''} · ${r.language ?? ''} · ${r.createdAt?.substring(0, 10) ?? ''}`));
        console.log(`   ${r.summary.substring(0, 120)}`);
        if (r.codeSnippets?.[0]) {
          console.log(chalk.cyan(`   \`\`\`${r.codeSnippets[0].language}`));
          console.log(chalk.cyan(`   ${r.codeSnippets[0].code.split('\n').slice(0, 3).join('\n   ')}`));
          console.log(chalk.cyan(`   \`\`\``));
        }
        console.log('');
      }
    } catch (error: any) {
      spinner.fail(error.message);
      process.exit(1);
    }
  });
