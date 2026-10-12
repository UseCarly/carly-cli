import { Command } from 'commander';
import { version } from './core/version.js';
import { registerAllCommands } from './commands/index.js';


const program = new Command();

program
  .name('carly')
  .description('Carly Forms & Bookings — manage forms, booking pages and availability from your terminal or MCP client')
  .version(version)
  .option('--api-key <key>', 'Carly API key (overrides env/config)')
  .option('--api-base-url <url>', 'Override the Carly API base URL')
  .option('--output <format>', 'Output format: json (default), pretty, or table')
  .option('--pretty', 'Shortcut for --output pretty')
  .option('--quiet', 'Suppress output (exit code only)')
  .option('--fields <fields>', 'Comma-separated fields. Narrows JSON keys; orders table columns.');

registerAllCommands(program);

program.parse(process.argv);
