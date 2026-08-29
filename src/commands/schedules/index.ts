import { z } from 'zod';
import { executeCommand } from '../../core/handler.js';
import type { CommandDefinition } from '../../core/types.js';
import {
  _availabilityRowSchema,
  _boolish,
  _dateOverrideSchema,
  _jsonArrayPreprocessor,
} from '../booking-pages/index.js';

// Schedules are the working-hours library booking pages point at: a person
// owns any number and has exactly one default (pages with no --schedule-id
// follow it); a team owns shared schedules a team page can impose on every
// host. Hours live HERE — `booking-pages update --availability` edits the
// page's schedule (or gives a page that follows the default its own copy).

const _hoursFields = {
  availability: z
    .preprocess(_jsonArrayPreprocessor, z.array(_availabilityRowSchema))
    .optional(),
  dateOverrides: z
    .preprocess(_jsonArrayPreprocessor, z.array(_dateOverrideSchema))
    .optional(),
};

const _hoursCliOptions = [
  {
    flags: '--availability <json>',
    field: 'availability',
    description:
      'Weekly hours as JSON: [{"days":[1,2,3,4,5],"start_time":"09:00","end_time":"17:00"}] (days: Sun=0..Sat=6). Replaces the weekly grid; overrides are untouched',
  },
  {
    flags: '--date-overrides <json>',
    field: 'dateOverrides',
    description:
      'One-off exceptions as JSON, each replacing the weekly hours for its date: [{"date":"2026-12-24","windows":[]}] blocks the day. "[]" clears every override',
  },
];

const _hoursFieldMappings: Record<string, 'path' | 'query' | 'body'> = {
  availability: 'body',
  dateOverrides: 'body',
};

const _scheduleIdArg = { name: 'schedule-id', field: 'scheduleId', required: true };
const _scheduleIdSchema = { scheduleId: z.coerce.number().int().positive() };

export const schedulesListCommand: CommandDefinition = {
  name: 'schedules_list',
  group: 'schedules',
  subcommand: 'list',
  description:
    'List the working-hours schedules you can use: your own (one is the default every page without --schedule-id follows), then those of each team you manage. Each carries its weekly hours, date overrides, timezone and the pages using it.',
  examples: ['carly schedules list', 'carly schedules list --output table'],
  inputSchema: z.object({}),
  cliMappings: {},
  endpoint: { method: 'GET', path: '/schedules' },
  fieldMappings: {},
  scope: 'booking_pages:read',
  defaultColumns: ['id', 'name', 'summary', 'resolved_timezone', 'is_default'],
  handler: (input, client) => executeCommand(schedulesListCommand, input, client),
};

export const schedulesGetCommand: CommandDefinition = {
  name: 'schedules_get',
  group: 'schedules',
  subcommand: 'get',
  description: 'Get one schedule by ID, with its hours, overrides and the booking pages that use it.',
  examples: ['carly schedules get 12', 'carly schedules get 12 --pretty'],
  inputSchema: z.object({ ..._scheduleIdSchema }),
  cliMappings: { args: [_scheduleIdArg] },
  endpoint: { method: 'GET', path: '/schedules/{scheduleId}' },
  fieldMappings: { scheduleId: 'path' },
  scope: 'booking_pages:read',
  handler: (input, client) => executeCommand(schedulesGetCommand, input, client),
};

export const schedulesCreateCommand: CommandDefinition = {
  name: 'schedules_create',
  group: 'schedules',
  subcommand: 'create',
  description:
    'Add a schedule to your library (or a team\'s with --organization-id; a team schedule needs --timezone). Your first schedule becomes your default; --is-default makes a later one the default. --for-user-id seeds a 9-5 default for a team member who has no hours yet. Requires the `booking_pages:write` scope.',
  examples: [
    `carly schedules create --name "Working hours" --timezone America/New_York --availability '[{"days":[1,2,3,4,5],"start_time":"09:00","end_time":"17:00"}]'`,
    `carly schedules create --name "Front desk" --organization-id 4 --timezone America/Chicago --availability '[{"days":[1,2,3,4,5],"start_time":"08:00","end_time":"16:00"}]'`,
    'carly schedules create --for-user-id 388   # give a member with no hours a 9-5 default',
  ],
  inputSchema: z.object({
    name: z.string().trim().optional(),
    timezone: z.string().optional(),
    organizationId: z.coerce.number().int().positive().optional(),
    forUserId: z.coerce.number().int().positive().optional(),
    isDefault: _boolish.optional(),
    ..._hoursFields,
  }),
  cliMappings: {
    options: [
      { flags: '--name <name>', field: 'name', description: 'Schedule name (default "Working hours")' },
      { flags: '--timezone <tz>', field: 'timezone', description: 'IANA timezone the hours are written in (required for a team schedule)' },
      { flags: '--organization-id <id>', field: 'organizationId', description: 'Create it in this team\'s library instead of yours' },
      { flags: '--for-user-id <id>', field: 'forUserId', description: 'Seed a default 9-5 for this team member (they must have no hours yet)' },
      { flags: '--is-default <true|false>', field: 'isDefault', description: 'Make it your default schedule' },
      ..._hoursCliOptions,
    ],
  },
  endpoint: { method: 'POST', path: '/schedules' },
  fieldMappings: {
    name: 'body',
    timezone: 'body',
    organizationId: 'body',
    forUserId: 'body',
    isDefault: 'body',
    ..._hoursFieldMappings,
  },
  scope: 'booking_pages:write',
  handler: (input, client) => executeCommand(schedulesCreateCommand, input, client),
};

export const schedulesUpdateCommand: CommandDefinition = {
  name: 'schedules_update',
  group: 'schedules',
  subcommand: 'update',
  description:
    'Change a schedule\'s name, timezone, weekly hours or date overrides. Every booking page using the schedule changes with it (`schedules get` shows which). Only the fields you pass change; --availability and --date-overrides are independent. Requires the `booking_pages:write` scope.',
  examples: [
    'carly schedules update 12 --timezone Europe/Berlin',
    `carly schedules update 12 --availability '[{"days":[2,4],"start_time":"13:00","end_time":"15:30"}]'`,
    `carly schedules update 12 --date-overrides '[]'   # clear every override`,
  ],
  inputSchema: z.object({
    ..._scheduleIdSchema,
    name: z.string().trim().min(1).optional(),
    timezone: z.string().optional(),
    ..._hoursFields,
  }),
  cliMappings: {
    args: [_scheduleIdArg],
    options: [
      { flags: '--name <name>', field: 'name', description: 'Schedule name' },
      { flags: '--timezone <tz>', field: 'timezone', description: 'IANA timezone the hours are written in' },
      ..._hoursCliOptions,
    ],
  },
  endpoint: { method: 'PATCH', path: '/schedules/{scheduleId}' },
  fieldMappings: {
    scheduleId: 'path',
    name: 'body',
    timezone: 'body',
    ..._hoursFieldMappings,
  },
  scope: 'booking_pages:write',
  handler: (input, client) => executeCommand(schedulesUpdateCommand, input, client),
};

export const schedulesDeleteCommand: CommandDefinition = {
  name: 'schedules_delete',
  group: 'schedules',
  subcommand: 'delete',
  description:
    'Delete a schedule. Refused while any booking page uses it (the error names the pages); deleting your default promotes the next one. Requires the `booking_pages:write` scope.',
  examples: ['carly schedules delete 12'],
  inputSchema: z.object({ ..._scheduleIdSchema }),
  cliMappings: { args: [_scheduleIdArg] },
  endpoint: { method: 'DELETE', path: '/schedules/{scheduleId}' },
  fieldMappings: { scheduleId: 'path' },
  scope: 'booking_pages:write',
  handler: (input, client) => executeCommand(schedulesDeleteCommand, input, client),
};

export const schedulesSetDefaultCommand: CommandDefinition = {
  name: 'schedules_set_default',
  group: 'schedules',
  subcommand: 'set-default',
  description:
    'Make a schedule your default — every booking page without a --schedule-id follows it. Personal schedules only; teams have no default. Requires the `booking_pages:write` scope.',
  examples: ['carly schedules set-default 12'],
  inputSchema: z.object({ ..._scheduleIdSchema }),
  cliMappings: { args: [_scheduleIdArg] },
  endpoint: { method: 'POST', path: '/schedules/{scheduleId}/default' },
  fieldMappings: { scheduleId: 'path' },
  scope: 'booking_pages:write',
  handler: (input, client) => executeCommand(schedulesSetDefaultCommand, input, client),
};

export const schedulesCommands: CommandDefinition[] = [
  schedulesListCommand,
  schedulesGetCommand,
  schedulesCreateCommand,
  schedulesUpdateCommand,
  schedulesDeleteCommand,
  schedulesSetDefaultCommand,
];
