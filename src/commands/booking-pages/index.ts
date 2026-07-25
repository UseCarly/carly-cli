import { z } from 'zod';
import { executeCommand } from '../../core/handler.js';
import type { CommandDefinition } from '../../core/types.js';

export const bookingPagesListCommand: CommandDefinition = {
  name: 'booking_pages_list',
  group: 'booking-pages',
  subcommand: 'list',
  description: "List the authenticated user's booking pages (event types with public links)",
  examples: [
    'carly booking-pages list',
    'carly booking-pages list --output table',
    'carly booking-pages list --pretty',
  ],
  inputSchema: z.object({}),
  cliMappings: {},
  endpoint: { method: 'GET', path: '/booking-pages' },
  fieldMappings: {},
  defaultColumns: ['id', 'slug', 'title', 'length', 'is_active'],
  handler: (input, client) => executeCommand(bookingPagesListCommand, input, client),
};

export const bookingPagesGetCommand: CommandDefinition = {
  name: 'booking_pages_get',
  group: 'booking-pages',
  subcommand: 'get',
  description: 'Get a single booking page by its event type ID',
  examples: ['carly booking-pages get 42', 'carly booking-pages get 42 --pretty'],
  inputSchema: z.object({
    eventTypeId: z.coerce.number().int().positive(),
  }),
  cliMappings: {
    args: [{ name: 'event-type-id', field: 'eventTypeId', required: true }],
  },
  endpoint: { method: 'GET', path: '/booking-pages/{eventTypeId}' },
  fieldMappings: { eventTypeId: 'path' },
  handler: (input, client) => executeCommand(bookingPagesGetCommand, input, client),
};

// Accepts either a native array (MCP callers pass JSON directly) or a
// stringified JSON blob (CLI callers pass --flag '<json>'). Strings that
// don't parse are passed through so Zod surfaces the shape error.
const _jsonArrayPreprocessor = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  try {
    return JSON.parse(val);
  } catch {
    return val;
  }
};

// duration_options also accepts CSV (`15,30,60`) since it's just ints.
const _intListPreprocessor = (val: unknown): unknown => {
  if (typeof val !== 'string') return val;
  const trimmed = val.trim();
  if (trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return val;
    }
  }
  return trimmed
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const n = Number(s);
      return Number.isInteger(n) ? n : s;
    });
};

const _availabilityRowSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start_time: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM'),
  end_time: z.string().regex(/^\d{2}:\d{2}$/, 'must be HH:MM'),
});

// `extra="allow"` on the server — we only validate the two known-required
// fields and passthrough the rest (required, options, name, placeholder, …).
const _customQuestionSchema = z
  .object({
    label: z.string().min(1),
    type: z.string().min(1),
  })
  .passthrough();

// Booking-page content blocks. services/booking_widgets.normalize_widgets is
// the authority — it enforces the per-type required fields, length caps, and
// the allowed video hosts, then drops unknown keys. We validate only `type`
// (the one thing that gives a useful client-side error) and passthrough the
// rest, same as _customQuestionSchema.
const _widgetSchema = z
  .object({
    type: z.enum(['video', 'image', 'text', 'link', 'testimonial']),
  })
  .passthrough();

// Calendars whose events block availability on THIS page. Distinct from
// `calendar_key` (where the booking gets written). Server shape is
// {provider, integration_id, calendar_id} — the API aliases each inner key to
// camelCase too, but we emit snake_case to match the shape `booking-pages get`
// returns, so round-tripping a fetched page back through update just works.
const _availabilityCalendarKeySchema = z.object({
  provider: z.string().min(1),
  integration_id: z.coerce.number().int().positive(),
  calendar_id: z.string().min(1),
});

const _nestedBookingPageFields = {
  availability: z
    .preprocess(_jsonArrayPreprocessor, z.array(_availabilityRowSchema))
    .optional(),
  customQuestions: z
    .preprocess(_jsonArrayPreprocessor, z.array(_customQuestionSchema))
    .optional(),
  durationOptions: z
    .preprocess(_intListPreprocessor, z.array(z.number().int().positive()))
    .optional(),
  widgets: z.preprocess(_jsonArrayPreprocessor, z.array(_widgetSchema).max(20)).optional(),
};

const _nestedCliOptions = [
  {
    flags: '--availability <json>',
    field: 'availability',
    description:
      'Weekly availability as JSON: [{"days":[1,2,3,4,5],"start_time":"09:00","end_time":"17:00"}] (days: Sun=0..Sat=6)',
  },
  {
    flags: '--custom-questions <json>',
    field: 'customQuestions',
    description:
      'Custom questions as JSON: [{"label":"Company","type":"text","required":true}]',
  },
  {
    flags: '--duration-options <list>',
    field: 'durationOptions',
    description: 'Bookable durations as CSV (15,30,60) or JSON array ([15,30,60])',
  },
  {
    flags: '--widgets <json>',
    field: 'widgets',
    description:
      // No literal URL here on purpose: Zapier's D008 publishing check reads a
      // bare URL in help text as a malformed markdown link, which blocks
      // promoting the app. Keep the example URL-free.
      'Page content blocks as JSON, max 20. Each block has a type — video, image, text, link, or testimonial — plus that type\'s fields, e.g. {"type":"text","heading":"About","body":"..."}',
  },
];

const _nestedFieldMappings: Record<string, 'path' | 'query' | 'body'> = {
  availability: 'body',
  customQuestions: 'body',
  durationOptions: 'body',
  widgets: 'body',
};

// Server-side Pydantic coerces "true"/"false" → bool. Accept both so MCP
// callers passing a JSON bool and CLI callers passing a string both work.
const _boolish = z.union([z.boolean(), z.enum(['true', 'false'])]);

// Zod schema for the write fields shared by create and update.
// Nested fields (availability, customQuestions, durationOptions, widgets) are
// defined above in `_nestedBookingPageFields`.
const _scalarBookingPageFields = {
  slug: z.string().trim().optional(),
  description: z.string().optional(),
  duration: z.coerce.number().int().positive().optional(),
  location: z.string().optional(),
  videoProvider: z.string().optional(),
  calendarKey: z.string().optional(),
  timezone: z.string().optional(),
  username: z.string().trim().toLowerCase().optional(),
  displayName: z.string().optional(),
  eventNameTemplate: z.string().optional(),
  minNoticeMinutes: z.coerce.number().int().nonnegative().optional(),
  maxDaysAhead: z.coerce.number().int().positive().optional(),
  beforeEventBuffer: z.coerce.number().int().nonnegative().optional(),
  afterEventBuffer: z.coerce.number().int().nonnegative().optional(),
  slotInterval: z.coerce.number().int().positive().optional(),
  notificationEmail: z.string().trim().max(255).optional(),
  collectPhone: _boolish.optional(),
  collectCompany: _boolish.optional(),
};

const _scalarCliOptions = [
  { flags: '--slug <slug>', field: 'slug', description: 'URL slug (e.g. "15min")' },
  { flags: '--description <text>', field: 'description', description: 'Page description' },
  { flags: '--duration <min>', field: 'duration', description: 'Meeting length in minutes' },
  { flags: '--location <loc>', field: 'location', description: 'Meeting location (physical or URL)' },
  { flags: '--video-provider <provider>', field: 'videoProvider', description: 'Video provider (google_meet, teams, zoom, ...)' },
  { flags: '--calendar-key <key>', field: 'calendarKey', description: 'Target calendar key (see `carly calendars list`)' },
  { flags: '--timezone <tz>', field: 'timezone', description: 'IANA timezone (e.g. America/New_York)' },
  { flags: '--username <username>', field: 'username', description: 'Profile username (lowercase, a-z0-9-)' },
  { flags: '--display-name <name>', field: 'displayName', description: 'Public display name on the booking page' },
  { flags: '--event-name-template <tpl>', field: 'eventNameTemplate', description: 'Template for generated event titles' },
  { flags: '--min-notice-minutes <n>', field: 'minNoticeMinutes', description: 'Minimum notice before a booking (minutes)' },
  { flags: '--max-days-ahead <n>', field: 'maxDaysAhead', description: 'Max days ahead a booking can be placed' },
  { flags: '--before-event-buffer <min>', field: 'beforeEventBuffer', description: 'Buffer before each meeting (minutes)' },
  { flags: '--after-event-buffer <min>', field: 'afterEventBuffer', description: 'Buffer after each meeting (minutes)' },
  { flags: '--slot-interval <min>', field: 'slotInterval', description: 'Slot interval override (minutes)' },
  { flags: '--notification-email <email>', field: 'notificationEmail', description: 'Send new-booking notifications here instead of the account email' },
  { flags: '--collect-phone <true|false>', field: 'collectPhone', description: 'Ask the guest for a phone number' },
  { flags: '--collect-company <true|false>', field: 'collectCompany', description: 'Ask the guest for a company name' },
];

const _scalarFieldMappings: Record<string, 'path' | 'query' | 'body'> = {
  slug: 'body',
  description: 'body',
  duration: 'body',
  location: 'body',
  videoProvider: 'body',
  calendarKey: 'body',
  timezone: 'body',
  username: 'body',
  displayName: 'body',
  eventNameTemplate: 'body',
  minNoticeMinutes: 'body',
  maxDaysAhead: 'body',
  beforeEventBuffer: 'body',
  afterEventBuffer: 'body',
  slotInterval: 'body',
  notificationEmail: 'body',
  collectPhone: 'body',
  collectCompany: 'body',
};

export const bookingPagesCreateCommand: CommandDefinition = {
  name: 'booking_pages_create',
  group: 'booking-pages',
  subcommand: 'create',
  description:
    'Create a new booking page. Requires the `booking_pages:write` scope. Accepts nested fields (--availability, --custom-questions, --duration-options, --widgets) as JSON. Availability calendars are not settable on create — a new page uses the account-wide conflict-check selection until you narrow it with an update.',
  examples: [
    'carly booking-pages create --title "15 minute intro" --duration 15 --slug 15min',
    'carly booking-pages create --title "Deep dive" --duration 60 --video-provider google_meet --location "Remote"',
    `carly booking-pages create --title "Coffee chat" --duration 30 --availability '[{"days":[1,2,3,4,5],"start_time":"09:00","end_time":"17:00"}]'`,
    `carly booking-pages create --title "Intake call" --duration 45 --custom-questions '[{"label":"Company","type":"text","required":true}]' --duration-options 30,45,60`,
    `carly booking-pages create --title "Demo" --duration 30 --widgets '[{"type":"text","heading":"What we cover","body":"A 30-minute walkthrough."}]'`,
  ],
  inputSchema: z.object({
    title: z.string().trim().min(1),
    ..._scalarBookingPageFields,
    ..._nestedBookingPageFields,
  }),
  cliMappings: {
    options: [
      { flags: '--title <title>', field: 'title', description: 'Page title (required)' },
      ..._scalarCliOptions,
      ..._nestedCliOptions,
    ],
  },
  endpoint: { method: 'POST', path: '/booking-pages' },
  fieldMappings: {
    title: 'body',
    ..._scalarFieldMappings,
    ..._nestedFieldMappings,
  },
  handler: (input, client) => executeCommand(bookingPagesCreateCommand, input, client),
};

export const bookingPagesUpdateCommand: CommandDefinition = {
  name: 'booking_pages_update',
  group: 'booking-pages',
  subcommand: 'update',
  description:
    'Update an existing booking page by its event type ID. Requires the `booking_pages:write` scope. Only fields you pass are updated. Nested fields (--availability, --custom-questions, --duration-options, --widgets, --availability-calendar-keys) accept JSON and replace the previous value.',
  examples: [
    'carly booking-pages update 42 --description "Updated description"',
    'carly booking-pages update 42 --is-active false',
    'carly booking-pages update 42 --duration 45 --min-notice-minutes 60',
    `carly booking-pages update 42 --availability '[{"days":[1,2,3,4,5],"start_time":"10:00","end_time":"16:00"}]'`,
    'carly booking-pages update 42 --duration-options 15,30,60',
    `carly booking-pages update 42 --widgets '[{"type":"video","url":"https://youtu.be/dQw4w9WgXcQ","title":"How this works"}]'`,
    `carly booking-pages update 42 --availability-calendar-keys '[{"provider":"google","integration_id":12,"calendar_id":"primary"}]'`,
  ],
  inputSchema: z.object({
    eventTypeId: z.coerce.number().int().positive(),
    title: z.string().trim().min(1).optional(),
    isActive: _boolish.optional(),
    // Update-only: BookingPageCreateRequest has no availability_calendar_keys,
    // so a new page inherits the account-wide "check for conflicts on"
    // selection until you narrow it here.
    availabilityCalendarKeys: z
      .preprocess(_jsonArrayPreprocessor, z.array(_availabilityCalendarKeySchema))
      .optional(),
    ..._scalarBookingPageFields,
    ..._nestedBookingPageFields,
  }),
  cliMappings: {
    args: [{ name: 'event-type-id', field: 'eventTypeId', required: true }],
    options: [
      { flags: '--title <title>', field: 'title', description: 'Page title' },
      { flags: '--is-active <true|false>', field: 'isActive', description: 'Enable or disable the page' },
      {
        flags: '--availability-calendar-keys <json>',
        field: 'availabilityCalendarKeys',
        description:
          'Calendars that block availability on THIS page, as JSON: [{"provider":"google","integration_id":12,"calendar_id":"primary"}] (see `carly calendars list`)',
      },
      ..._scalarCliOptions,
      ..._nestedCliOptions,
    ],
  },
  endpoint: { method: 'PATCH', path: '/booking-pages/{eventTypeId}' },
  fieldMappings: {
    eventTypeId: 'path',
    title: 'body',
    isActive: 'body',
    availabilityCalendarKeys: 'body',
    ..._scalarFieldMappings,
    ..._nestedFieldMappings,
  },
  handler: (input, client) => executeCommand(bookingPagesUpdateCommand, input, client),
};

export const bookingPagesDeleteCommand: CommandDefinition = {
  name: 'booking_pages_delete',
  group: 'booking-pages',
  subcommand: 'delete',
  description:
    'Deactivate (pause) a booking page by its event type ID. The server soft-deletes: the page is hidden from public booking (is_active=false) but the row is retained and the page can be re-activated via `update <id> --is-active true`. Requires the `booking_pages:write` scope.',
  examples: [
    'carly booking-pages delete 42',
    'carly booking-pages update 42 --is-active true   # re-activate after delete',
  ],
  inputSchema: z.object({
    eventTypeId: z.coerce.number().int().positive(),
  }),
  cliMappings: {
    args: [{ name: 'event-type-id', field: 'eventTypeId', required: true }],
  },
  endpoint: { method: 'DELETE', path: '/booking-pages/{eventTypeId}' },
  fieldMappings: { eventTypeId: 'path' },
  handler: (input, client) => executeCommand(bookingPagesDeleteCommand, input, client),
};

export const bookingPagesCommands: CommandDefinition[] = [
  bookingPagesListCommand,
  bookingPagesGetCommand,
  bookingPagesCreateCommand,
  bookingPagesUpdateCommand,
  bookingPagesDeleteCommand,
];
