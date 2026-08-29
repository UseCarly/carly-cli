import type { Command } from 'commander';
import { resolveAuth } from '../core/auth.js';
import { CarlyClient } from '../core/client.js';
import { output, outputError } from '../core/output.js';
import type { CommandDefinition, GlobalOptions } from '../core/types.js';

import { registerLoginCommand } from './auth/login.js';
import { registerLogoutCommand } from './auth/logout.js';
import { registerAuthStatusCommand } from './auth/status.js';
import { registerCalendarsConnectCommand, registerSignupCommand } from './calendars/connect.js';
import { profileCommands } from './profile/index.js';
import { calendarsCommands } from './calendars/index.js';
import { bookingPagesCommands } from './booking-pages/index.js';
import { schedulesCommands } from './schedules/index.js';
import { eventTypesCommands } from './event-types/index.js';
import { slotsCommands } from './slots/index.js';
import { bookingsCommands } from './bookings/index.js';

export const allCommands: CommandDefinition[] = [
  ...profileCommands,
  ...calendarsCommands,
  ...bookingPagesCommands,
  ...schedulesCommands,
  ...eventTypesCommands,
  ...slotsCommands,
  ...bookingsCommands,
];

export function registerAllCommands(program: Command): void {
  // Auth commands (special — no CommandDefinition pattern; they manage local config).
  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerAuthStatusCommand(program);
  registerSignupCommand(program);

  // MCP server start command.
  program
    .command('mcp')
    .description('Start the Carly MCP server (stdio transport, for AI agents)')
    .action(async () => {
      const { startMcpServer } = await import('../mcp/server.js');
      await startMcpServer();
    });

  // Group CommandDefinitions by their `group` field.
  const groups = new Map<string, CommandDefinition[]>();
  for (const cmd of allCommands) {
    const list = groups.get(cmd.group) ?? [];
    list.push(cmd);
    groups.set(cmd.group, list);
  }

  for (const [group, cmds] of groups) {
    const groupCmd = program.command(group).description(`${group} commands`);

    for (const cmdDef of cmds) {
      const sub = groupCmd.command(cmdDef.subcommand).description(cmdDef.description);

      for (const arg of cmdDef.cliMappings.args ?? []) {
        if (arg.required) {
          sub.argument(`<${arg.name}>`, arg.field);
        } else {
          sub.argument(`[${arg.name}]`, arg.field);
        }
      }

      for (const opt of cmdDef.cliMappings.options ?? []) {
        sub.option(opt.flags, opt.description ?? '');
      }

      sub
        .option('--output <format>', 'Output format: json (default), pretty, or table')
        .option('--pretty', 'Shortcut for --output pretty')
        .option('--quiet', 'Suppress output (exit code only)')
        .option(
          '--fields <fields>',
          'Comma-separated fields. Narrows JSON keys; orders table columns.',
        );

      if (cmdDef.examples?.length) {
        sub.addHelpText('after', '\nExamples:\n' + cmdDef.examples.map((e) => `  ${e}`).join('\n'));
      }

      sub.action(async (...actionArgs: any[]) => {
        const instanceOpts = actionArgs[actionArgs.length - 2] as Record<string, any>;
        const globalOpts = sub.optsWithGlobals() as GlobalOptions & Record<string, any>;
        if (instanceOpts.output) globalOpts.output = instanceOpts.output;
        if (instanceOpts.pretty) globalOpts.pretty = true;
        if (instanceOpts.quiet) globalOpts.quiet = true;
        if (instanceOpts.fields) globalOpts.fields = instanceOpts.fields;

        try {
          const { apiKey, baseUrl } = await resolveAuth({
            apiKeyFlag: globalOpts.apiKey,
            baseUrlFlag: globalOpts.apiBaseUrl,
          });
          const client = new CarlyClient({ apiKey, baseUrl });

          const input: Record<string, unknown> = {};

          const positionalArgs = actionArgs.slice(0, actionArgs.length - 2);
          for (let i = 0; i < (cmdDef.cliMappings.args ?? []).length; i++) {
            const argDef = cmdDef.cliMappings.args![i];
            if (positionalArgs[i] !== undefined) {
              input[argDef.field] = positionalArgs[i];
            }
          }

          for (const opt of cmdDef.cliMappings.options ?? []) {
            const key = camelCase(opt.flags.match(/--([a-z0-9-]+)/)?.[1] ?? '');
            if (instanceOpts[key] !== undefined) {
              input[opt.field] = instanceOpts[key];
            }
          }

          const parsed = cmdDef.inputSchema.safeParse(input);
          if (!parsed.success) {
            const issues = parsed.error.issues
              .map((i) => `  ${i.path.join('.')}: ${i.message}`)
              .join('\n');
            throw new Error(`Validation error:\n${issues}`);
          }

          const result = await cmdDef.handler(parsed.data, client);
          output(result, globalOpts, cmdDef.defaultColumns);
        } catch (err) {
          outputError(err, globalOpts);
        }
      });
    }
  }

  // Register OAuth-connect subcommands on the `calendars` group after the main
  // loop above has created it. These open the dashboard OAuth pages in the
  // user's browser — no API call, so they don't fit the CommandDefinition shape.
  registerCalendarsConnectCommand(program);
}

function camelCase(str: string): string {
  return str.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
