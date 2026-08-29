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
export const _jsonArrayPreprocessor = (val: unknown): unknown => {
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

export const _availabilityRowSchema = z.object({
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

// One-off exceptions that REPLACE the weekly pattern for a single date, read
// in the page's timezone. Zero windows blocks the whole day; otherwise only
// the listed windows are bookable. Inner keys are snake_case to match what
// `booking-pages get` returns, same round-tripping rationale as
// _availabilityCalendarKeySchema.
//
// Cross-row rules (duplicate dates, overlapping windows, the 100-override /
// 500-window caps) are left to the server, which reports them by date —
// re-implementing them here would be a second source of truth that can drift.
//
// Unlike _availabilityRowSchema, the times are zero-padded here rather than
// required to arrive padded: OverrideWindow on the server normalizes "9:00" to
// "09:00", so rejecting it client-side would make the CLI stricter than the API
// it fronts. Padding first also makes the start<end string compare correct —
// unpadded, "9:00" sorts after "12:00".
const _padHhmm = (v: string): string => {
  const [h, m] = v.split(':');
  return `${h.padStart(2, '0')}:${m}`;
};
const _hhmm = z
  .string()
  .regex(/^([01]?\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (00:00-23:59)')
  .transform(_padHhmm);

export const _dateOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD'),
  windows: z
    .array(
      z
        .object({ start_time: _hhmm, end_time: _hhmm })
        .refine((w) => w.start_time < w.end_time, {
          message: 'start_time must be before end_time',
        }),
    )
    .default([]),
});

const _nestedBookingPageFields = {
  availability: z
    .preprocess(_jsonArrayPreprocessor, z.array(_availabilityRowSchema))
    .optional(),
  dateOverrides: z
    .preprocess(_jsonArrayPreprocessor, z.array(_dateOverrideSchema))
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
    flags: '--date-overrides <json>',
    field: 'dateOverrides',
    description:
      'One-off exceptions to the weekly hours, as JSON. Each entry replaces the weekly pattern for that date: [{"date":"2026-12-24","windows":[]}] blocks the day, [{"date":"2026-12-24","windows":[{"start_time":"09:00","end_time":"12:00"}]}] gives it custom hours',
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
  dateOverrides: 'body',
  customQuestions: 'body',
  durationOptions: 'body',
  widgets: 'body',
};

// Server-side Pydantic coerces "true"/"false" → bool. Accept both so MCP
// callers passing a JSON bool and CLI callers passing a string both work.
export const _boolish = z.union([z.boolean(), z.enum(['true', 'false'])]);

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
  // --- booking-pages-v2 + schedule library. Generated against the server's
  // schemas/api_v1_fields.txt; `npm run fields:check` fails when they drift.
  scheduleId: z.coerce.number().int().optional(),
  bookingWindowMode: z.enum(['rolling', 'business_days', 'range']).optional(),
  bookingWindowBusinessDays: z.coerce.number().int().optional(),
  bookingWindowStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
  bookingWindowEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be YYYY-MM-DD').optional(),
  bookingLimitCount: z.coerce.number().int().optional(),
  bookingLimitPeriod: z.enum(['day', 'week', 'month', 'year']).optional(),
  bookingLimitDurationMinutes: z.coerce.number().int().optional(),
  bookerActiveBookingLimit: z.coerce.number().int().optional(),
  offsetStartMinutes: z.coerce.number().int().optional(),
  onlyShowFirstAvailableSlot: _boolish.optional(),
  disableGuests: _boolish.optional(),
  hideCalendarNotes: _boolish.optional(),
  hideCalendarEventDetails: _boolish.optional(),
  hideOrganizerEmail: _boolish.optional(),
  disableCancelling: _boolish.optional(),
  disableRescheduling: _boolish.optional(),
  minimumRescheduleNotice: z.coerce.number().int().optional(),
  requiresConfirmation: _boolish.optional(),
  confirmationThresholdMinutes: z.coerce.number().int().optional(),
  successRedirectUrl: z.string().optional(),
  forwardParamsSuccessRedirect: _boolish.optional(),
  lockedTimezone: z.string().optional(),
  color: z.string().optional(),
  requiresPrivateLink: _boolish.optional(),
  seatsPerTimeSlot: z.coerce.number().int().optional(),
  seatsShowAttendees: _boolish.optional(),
  seatsShowAvailabilityCount: _boolish.optional(),
  recurrenceFrequency: z.enum(['weekly', 'monthly', 'yearly']).optional(),
  recurrenceInterval: z.coerce.number().int().optional(),
  recurrenceOccurrences: z.coerce.number().int().optional(),
  reminderConfigs: z.preprocess(_jsonArrayPreprocessor, z.array(z.object({}).passthrough())).optional(),
  schedulingType: z.enum(['collective', 'round_robin', 'managed']).optional(),
  hosts: z.preprocess(_jsonArrayPreprocessor, z.array(z.object({ user_id: z.coerce.number().int().positive() }).passthrough())).optional(),
  assignAllTeamMembers: _boolish.optional(),
  memberFieldsUnlocked: _boolish.optional(),
  rrResetInterval: z.enum(['day', 'month']).optional(),
  rrTimestampBasis: z.enum(['created_at', 'start_time']).optional(),
  include_no_show_in_rr_calculation: _boolish.optional(),
  rescheduleWithSameRoundRobinHost: _boolish.optional(),
};

const _scalarCliOptions = [
  { flags: '--slug <slug>', field: 'slug', description: 'URL slug (e.g. "15min")' },
  { flags: '--description <text>', field: 'description', description: 'Page description' },
  { flags: '--duration <min>', field: 'duration', description: 'Meeting length in minutes' },
  { flags: '--location <loc>', field: 'location', description: 'Meeting location (physical or URL)' },
  { flags: '--video-provider <provider>', field: 'videoProvider', description: 'Video provider (google_meet, teams, zoom, ...)' },
  { flags: '--calendar-key <key>', field: 'calendarKey', description: 'Target calendar key (see `carly calendars list`)' },
  { flags: '--timezone <tz>', field: 'timezone', description: 'IANA timezone (e.g. America/New_York)' },
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
  { flags: '--schedule-id <n>', field: 'scheduleId', description: "Schedule this page books on (see `carly schedules list`); omit to follow your default" },
  { flags: '--booking-window-mode <rolling|business_days|range>', field: 'bookingWindowMode', description: "How far ahead guests can book: rolling (calendar days), business_days, or range" },
  { flags: '--booking-window-business-days <n>', field: 'bookingWindowBusinessDays', description: "Business days ahead when --booking-window-mode is business_days" },
  { flags: '--booking-window-start <date>', field: 'bookingWindowStart', description: "First bookable date (YYYY-MM-DD) when --booking-window-mode is range" },
  { flags: '--booking-window-end <date>', field: 'bookingWindowEnd', description: "Last bookable date (YYYY-MM-DD) when --booking-window-mode is range" },
  { flags: '--booking-limit-count <n>', field: 'bookingLimitCount', description: "Max bookings per --booking-limit-period" },
  { flags: '--booking-limit-period <day|week|month|year>', field: 'bookingLimitPeriod', description: "Period for the booking limits: day, week, month, or year" },
  { flags: '--booking-limit-duration-minutes <n>', field: 'bookingLimitDurationMinutes', description: "Max booked minutes per --booking-limit-period" },
  { flags: '--booker-active-booking-limit <n>', field: 'bookerActiveBookingLimit', description: "Max upcoming bookings one guest email may hold" },
  { flags: '--offset-start-minutes <n>', field: 'offsetStartMinutes', description: "Shift every slot start by this many minutes" },
  { flags: '--only-show-first-available-slot <true|false>', field: 'onlyShowFirstAvailableSlot', description: "Offer only the first free slot of each day" },
  { flags: '--disable-guests <true|false>', field: 'disableGuests', description: "Do not let the booker add extra guests" },
  { flags: '--hide-calendar-notes <true|false>', field: 'hideCalendarNotes', description: "Keep guest notes out of the calendar event" },
  { flags: '--hide-calendar-event-details <true|false>', field: 'hideCalendarEventDetails', description: "Show the calendar event as \"Busy\"" },
  { flags: '--hide-organizer-email <true|false>', field: 'hideOrganizerEmail', description: "Hide the organizer email where the provider allows it" },
  { flags: '--disable-cancelling <true|false>', field: 'disableCancelling', description: "Guests cannot cancel" },
  { flags: '--disable-rescheduling <true|false>', field: 'disableRescheduling', description: "Guests cannot reschedule" },
  { flags: '--minimum-reschedule-notice <n>', field: 'minimumRescheduleNotice', description: "Minutes before start after which guests can no longer reschedule" },
  { flags: '--requires-confirmation <true|false>', field: 'requiresConfirmation', description: "Bookings wait for host approval" },
  { flags: '--confirmation-threshold-minutes <n>', field: 'confirmationThresholdMinutes', description: "With --requires-confirmation: auto-accept bookings this many minutes or more away" },
  { flags: '--success-redirect-url <text>', field: 'successRedirectUrl', description: "Send guests to this URL after booking" },
  { flags: '--forward-params-success-redirect <true|false>', field: 'forwardParamsSuccessRedirect', description: "Append booking details as query params to the success redirect" },
  { flags: '--locked-timezone <text>', field: 'lockedTimezone', description: "Show times in this IANA timezone for every guest" },
  { flags: '--color <text>', field: 'color', description: "Accent colour as #RRGGBB" },
  { flags: '--requires-private-link <true|false>', field: 'requiresPrivateLink', description: "Only private links can book this page" },
  { flags: '--seats-per-time-slot <n>', field: 'seatsPerTimeSlot', description: "Seats per occurrence (1 = one guest per slot)" },
  { flags: '--seats-show-attendees <true|false>', field: 'seatsShowAttendees', description: "Show attendee names on seated slots" },
  { flags: '--seats-show-availability-count <true|false>', field: 'seatsShowAvailabilityCount', description: "Show the remaining seat count" },
  { flags: '--recurrence-frequency <weekly|monthly|yearly>', field: 'recurrenceFrequency', description: "Repeat bookings: weekly, monthly, or yearly" },
  { flags: '--recurrence-interval <n>', field: 'recurrenceInterval', description: "Repeat every N periods" },
  { flags: '--recurrence-occurrences <n>', field: 'recurrenceOccurrences', description: "Max occurrences in a recurring series" },
  { flags: '--reminder-configs <json>', field: 'reminderConfigs', description: "Authored reminder emails as a JSON array; see the API reference for the shape" },
  { flags: '--scheduling-type <collective|round_robin|managed>', field: 'schedulingType', description: "Team page kind: round_robin, collective, or managed" },
  { flags: '--hosts <json>', field: 'hosts', description: "Team hosts as JSON: [{\"user_id\":12,\"is_fixed\":false,\"priority\":1,\"schedule_id\":null}]" },
  { flags: '--assign-all-team-members <true|false>', field: 'assignAllTeamMembers', description: "Every active team member hosts this page" },
  { flags: '--member-fields-unlocked <true|false>', field: 'memberFieldsUnlocked', description: "Managed template: members own their hours, location, and calendar" },
  { flags: '--rr-reset-interval <day|month>', field: 'rrResetInterval', description: "Round-robin fairness reset: day or month" },
  { flags: '--rr-timestamp-basis <created_at|start_time>', field: 'rrTimestampBasis', description: "Round-robin ordering basis: created_at or start_time" },
  { flags: '--include-no-show-in-rr-calculation <true|false>', field: 'include_no_show_in_rr_calculation', description: "Count no-shows toward round-robin fairness" },
  { flags: '--reschedule-with-same-round-robin-host <true|false>', field: 'rescheduleWithSameRoundRobinHost', description: "Reschedules stay with the original host" },
];

const _scalarFieldMappings: Record<string, 'path' | 'query' | 'body'> = {
  slug: 'body',
  description: 'body',
  duration: 'body',
  location: 'body',
  videoProvider: 'body',
  calendarKey: 'body',
  timezone: 'body',
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
  scheduleId: 'body',
  bookingWindowMode: 'body',
  bookingWindowBusinessDays: 'body',
  bookingWindowStart: 'body',
  bookingWindowEnd: 'body',
  bookingLimitCount: 'body',
  bookingLimitPeriod: 'body',
  bookingLimitDurationMinutes: 'body',
  bookerActiveBookingLimit: 'body',
  offsetStartMinutes: 'body',
  onlyShowFirstAvailableSlot: 'body',
  disableGuests: 'body',
  hideCalendarNotes: 'body',
  hideCalendarEventDetails: 'body',
  hideOrganizerEmail: 'body',
  disableCancelling: 'body',
  disableRescheduling: 'body',
  minimumRescheduleNotice: 'body',
  requiresConfirmation: 'body',
  confirmationThresholdMinutes: 'body',
  successRedirectUrl: 'body',
  forwardParamsSuccessRedirect: 'body',
  lockedTimezone: 'body',
  color: 'body',
  requiresPrivateLink: 'body',
  seatsPerTimeSlot: 'body',
  seatsShowAttendees: 'body',
  seatsShowAvailabilityCount: 'body',
  recurrenceFrequency: 'body',
  recurrenceInterval: 'body',
  recurrenceOccurrences: 'body',
  reminderConfigs: 'body',
  schedulingType: 'body',
  hosts: 'body',
  assignAllTeamMembers: 'body',
  memberFieldsUnlocked: 'body',
  rrResetInterval: 'body',
  rrTimestampBasis: 'body',
  include_no_show_in_rr_calculation: 'body',
  rescheduleWithSameRoundRobinHost: 'body',
};

export const bookingPagesCreateCommand: CommandDefinition = {
  name: 'booking_pages_create',
  group: 'booking-pages',
  subcommand: 'create',
  description:
    'Create a new booking page. Requires the `booking_pages:write` scope. Every field of the public API is a flag: hours (--availability/--date-overrides, or --schedule-id to reuse a library schedule), team pages (--organization-id with --scheduling-type/--hosts), limits, privacy, seats, recurrence and reminders. Nested fields (--availability, --date-overrides, --custom-questions, --duration-options, --widgets, --hosts, --reminder-configs) take JSON. Availability calendars are not settable on create — a new page uses the account-wide conflict-check selection until you narrow it with an update.',
  examples: [
    'carly booking-pages create --title "15 minute intro" --duration 15 --slug 15min',
    'carly booking-pages create --title "Deep dive" --duration 60 --video-provider google_meet --location "Remote"',
    `carly booking-pages create --title "Coffee chat" --duration 30 --availability '[{"days":[1,2,3,4,5],"start_time":"09:00","end_time":"17:00"}]'`,
    `carly booking-pages create --title "Office hours" --duration 30 --date-overrides '[{"date":"2026-12-24","windows":[]},{"date":"2026-12-31","windows":[{"start_time":"09:00","end_time":"12:00"}]}]'`,
    `carly booking-pages create --title "Intake call" --duration 45 --custom-questions '[{"label":"Company","type":"text","required":true}]' --duration-options 30,45,60`,
    `carly booking-pages create --title "Demo" --duration 30 --widgets '[{"type":"text","heading":"What we cover","body":"A 30-minute walkthrough."}]'`,
  ],
  inputSchema: z.object({
    title: z.string().trim().min(1),
    username: z.string().trim().toLowerCase().optional(),
    scheduleName: z.string().optional(),
    organizationId: z.coerce.number().int().optional(),
    ..._scalarBookingPageFields,
    ..._nestedBookingPageFields,
  }),
  cliMappings: {
    options: [
      { flags: '--title <title>', field: 'title', description: 'Page title (required)' },
      { flags: '--username <username>', field: 'username', description: 'Profile username (lowercase, a-z0-9-); create only' },
      { flags: '--schedule-name <text>', field: 'scheduleName', description: "Name for the schedule created from --availability/--timezone (create only)" },
      { flags: '--organization-id <n>', field: 'organizationId', description: "Team this page belongs to (create only; makes it a team page)" },
      ..._scalarCliOptions,
      ..._nestedCliOptions,
    ],
  },
  endpoint: { method: 'POST', path: '/booking-pages' },
  fieldMappings: {
    title: 'body',
    username: 'body',
    scheduleName: 'body',
    organizationId: 'body',
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
    'Update an existing booking page by its event type ID. Requires the `booking_pages:write` scope. Only fields you pass are updated. Nested fields (--availability, --date-overrides, --custom-questions, --duration-options, --widgets, --availability-calendar-keys) accept JSON and replace the previous value. --availability and --date-overrides are independent: saving one leaves the other untouched, and --date-overrides "[]" clears every override.',
  examples: [
    'carly booking-pages update 42 --description "Updated description"',
    'carly booking-pages update 42 --is-active false',
    'carly booking-pages update 42 --duration 45 --min-notice-minutes 60',
    `carly booking-pages update 42 --availability '[{"days":[1,2,3,4,5],"start_time":"10:00","end_time":"16:00"}]'`,
    `carly booking-pages update 42 --date-overrides '[{"date":"2026-12-24","windows":[]}]'   # block Christmas Eve`,
    `carly booking-pages update 42 --date-overrides '[]'   # clear every override, weekly hours unchanged`,
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

export const bookingPagesCheckUsernameCommand: CommandDefinition = {
  name: 'booking_pages_check_username',
  group: 'booking-pages',
  subcommand: 'check-username',
  description:
    'Check whether a profile username is available before creating a page with --username. Requires the `booking_pages:write` scope.',
  examples: ['carly booking-pages check-username acme-sales'],
  inputSchema: z.object({
    username: z.string().trim().toLowerCase().min(1),
  }),
  cliMappings: {
    args: [{ name: 'username', field: 'username', required: true }],
  },
  endpoint: { method: 'GET', path: '/booking-pages/check-username' },
  fieldMappings: { username: 'query' },
  scope: 'booking_pages:write',
  handler: (input, client) => executeCommand(bookingPagesCheckUsernameCommand, input, client),
};

export const bookingPagesCommands: CommandDefinition[] = [
  bookingPagesListCommand,
  bookingPagesGetCommand,
  bookingPagesCreateCommand,
  bookingPagesUpdateCommand,
  bookingPagesDeleteCommand,
  bookingPagesCheckUsernameCommand,
];
