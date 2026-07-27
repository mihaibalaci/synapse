#!/usr/bin/env node
/**
 * ctx — Recall CLI
 *
 * Commands:
 *   synapse search <query>         Search the knowledge base
 *   synapse facts [--entity X]     Query atomic facts
 *   synapse history <entity>       View temporal evolution of an entity
 *   synapse capture <file>         Capture a session from a JSON file
 *   synapse insight <text>         Store a quick insight/fact
 *   synapse status                 Check system health + stats
 */

import { Command } from 'commander';
import { searchCommand } from './commands/search.js';
import { factsCommand } from './commands/facts.js';
import { historyCommand } from './commands/history.js';
import { captureCommand } from './commands/capture.js';
import { insightCommand } from './commands/insight.js';
import { statusCommand } from './commands/status.js';

const program = new Command();

program
  .name('synapse')
  .description('Recall CLI — search and capture engineering knowledge')
  .version('0.1.0');

program.addCommand(searchCommand);
program.addCommand(factsCommand);
program.addCommand(historyCommand);
program.addCommand(captureCommand);
program.addCommand(insightCommand);
program.addCommand(statusCommand);

program.parse();
