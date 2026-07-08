import { z } from 'zod';
import { executeCommand } from '../../core/handler.js';
import type { CommandDefinition } from '../../core/types.js';

export const bookingsListCommand: CommandDefinition = {
  name: 'bookings_list',
  group: 'bookings',
  subcommand: 'list',
  description: "List the authenticated user's bookings. Supports filters for status, event type, and time range.",
  examples: [
    'carly bookings list',
    'carly bookings list --output table',
    'carly bookings list --status accepted --limit 25',
    'carly bookings list --event-type-id 42 --start-time 2026-04-01T00:00:00Z',
  ],
  inputSchema: z.object({
    status: z.string().trim().optional(),
    eventTypeId: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().positive().max(1000).optional(),
    startTime: z.string().min(1).optional(),
    endTime: z.string().min(1).optional(),
  }),
  cliMappings: {
    options: [
      { flags: '--status <status>', field: 'status', description: 'Filter by booking status' },
      { flags: '--event-type-id <id>', field: 'eventTypeId', description: 'Filter by event type ID' },
      { flags: '--limit <n>', field: 'limit', description: 'Max bookings to return (1–1000, default 100)' },
      { flags: '--start-time <iso>', field: 'startTime', description: 'Range start (ISO 8601)' },
      { flags: '--end-time <iso>', field: 'endTime', description: 'Range end (ISO 8601)' },
    ],
  },
  endpoint: { method: 'GET', path: '/bookings' },
  fieldMappings: {
    status: 'query',
    eventTypeId: 'query',
    limit: 'query',
    startTime: 'query',
    endTime: 'query',
  },
  defaultColumns: ['uid', 'status', 'start_time', 'end_time', 'username', 'title', 'event_type_slug', 'event_type_id'],
  handler: (input, client) => executeCommand(bookingsListCommand, input, client),
};

export const bookingsGetCommand: CommandDefinition = {
  name: 'bookings_get',
  group: 'bookings',
  subcommand: 'get',
  description: 'Get a single booking by its UID',
  examples: ['carly bookings get abc123xyz', 'carly bookings get abc123xyz --pretty'],
  inputSchema: z.object({
    uid: z.string().min(1),
  }),
  cliMappings: {
    args: [{ name: 'uid', field: 'uid', required: true }],
  },
  endpoint: { method: 'GET', path: '/bookings/{uid}' },
  fieldMappings: { uid: 'path' },
  handler: (input, client) => executeCommand(bookingsGetCommand, input, client),
};

export const bookingsCommands: CommandDefinition[] = [bookingsListCommand, bookingsGetCommand];
