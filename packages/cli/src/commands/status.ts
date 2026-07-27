import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { api } from '../api-client.js';

export const statusCommand = new Command('status')
  .description('Check system health and statistics')
  .action(async () => {
    const spinner = ora('Checking status...').start();

    try {
      const health = await api('/health/ready', 'GET');
      spinner.stop();

      const statusIcon = health.status === 'ready' ? chalk.green('●') : chalk.red('●');
      console.log(`${statusIcon} ${chalk.bold('Recall')} — ${health.status}\n`);

      if (health.checks) {
        for (const [service, status] of Object.entries(health.checks)) {
          const icon = status === 'ok' ? chalk.green('✓') : chalk.red('✗');
          console.log(`  ${icon} ${service}: ${status}`);
        }
      }

      console.log(chalk.dim(`\n  URL: ${process.env.SYNAPSE_API_URL ?? 'http://localhost:3000'}`));
      console.log(chalk.dim(`  Version: ${health.version ?? 'unknown'}`));
    } catch (error: any) {
      spinner.fail(`Cannot reach API: ${error.message}`);
      process.exit(1);
    }
  });
