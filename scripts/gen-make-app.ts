/**
 * Codegen: emit Make (make.com) custom-app JSON from Carly's command defs.
 *
 *   npm run gen:make   ->   ../carly-make/
 *
 * Make has no clean local validator (unlike zapier validate), so this emits the
 * per-tab JSON (BASE, CONNECTION, and one file per MODULE) that you paste into
 * Make's app builder — or feed to the Make Apps CLI. Same single source of
 * truth as the CLI, MCP server, n8n node, Zapier app, and OpenAPI spec.
 *
 * Make module file shape: { metadata, communication, mappableParameters, interface }.
 * IML: {{parameters.x}} for inputs, {{connection.apiKey}} for auth, {{parse(...)}}
 * to turn a JSON-string input into a real array/object.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { profileCommands } from '../src/commands/profile/index.js';
import { calendarsCommands } from '../src/commands/calendars/index.js';
import { bookingPagesCommands } from '../src/commands/booking-pages/index.js';
import { schedulesCommands } from '../src/commands/schedules/index.js';
import { eventTypesCommands } from '../src/commands/event-types/index.js';
import { slotsCommands } from '../src/commands/slots/index.js';
import { bookingsCommands } from '../src/commands/bookings/index.js';
import type { CommandDefinition } from '../src/core/types.js';

const allCommands: CommandDefinition[] = [
  ...profileCommands,
  ...calendarsCommands,
  ...bookingPagesCommands,
  ...schedulesCommands,
  ...eventTypesCommands,
  ...slotsCommands,
  ...bookingsCommands,
];

// Apex host — matches the public docs at usecarly.com/developers. The
// dashboard.* subdomain serves the same API but the docs are canonical.
const BASE_URL = 'https://carlyassistant.com/api/v1';

const CONSTANT_BODY: Record<string, Record<string, unknown>> = {
  calendars_select: { selected: true },
  calendars_unselect: { selected: false },
};

// ---- Module metadata -------------------------------------------------------
// Make's naming conventions: labels are sentence case with a verb, article and
// entity; descriptions are third person present and end in a period. `action`
// is the CRUD type for Action modules (search modules don't take one).
// https://developers.make.com/custom-apps-documentation/best-practices/naming-conventions

type CrudAction = 'create' | 'read' | 'update' | 'delete';
interface ModuleMeta {
  label: string;
  description: string;
  group: string;
  action?: CrudAction;
  /** Key into RESPONSE_SHAPES — the entity this module returns. */
  shape?: string;
}

const MODULE_META: Record<string, ModuleMeta> = {
  whoami: {
    label: 'Get profile',
    description: 'Retrieves the account the API key belongs to.',
    group: 'Profile',
    action: 'read',
    shape: 'profile',
  },
  booking_pages_list: {
    label: 'List booking pages',
    description: 'Lists your booking pages.',
    group: 'Booking pages',
    shape: 'bookingPage',
  },
  booking_pages_get: {
    label: 'Get a booking page',
    description: 'Retrieves a booking page by its event type ID.',
    group: 'Booking pages',
    action: 'read',
    shape: 'bookingPage',
  },
  booking_pages_create: {
    label: 'Create a booking page',
    description: 'Creates a booking page.',
    group: 'Booking pages',
    action: 'create',
    shape: 'bookingPage',
  },
  booking_pages_update: {
    label: 'Update a booking page',
    description: 'Updates a booking page.',
    group: 'Booking pages',
    action: 'update',
    shape: 'bookingPage',
  },
  booking_pages_delete: {
    label: 'Delete a booking page',
    description: 'Deactivates a booking page.',
    group: 'Booking pages',
    action: 'delete',
    shape: 'ok',
  },
  bookings_list: {
    label: 'List bookings',
    description: 'Lists your bookings.',
    group: 'Bookings',
    shape: 'booking',
  },
  bookings_get: {
    label: 'Get a booking',
    description: 'Retrieves a booking by its UID.',
    group: 'Bookings',
    action: 'read',
    shape: 'booking',
  },
  calendars_list: {
    label: 'List calendars',
    description: 'Lists your connected calendars.',
    group: 'Calendars',
    shape: 'calendar',
  },
  calendars_select: {
    label: 'Add a calendar to availability',
    description: 'Adds a calendar to your availability.',
    group: 'Calendars',
    action: 'update',
    shape: 'calendar',
  },
  calendars_unselect: {
    label: 'Remove a calendar from availability',
    description: 'Removes a calendar from your availability.',
    group: 'Calendars',
    action: 'update',
    shape: 'calendar',
  },
  event_types_list: {
    label: 'List event types',
    description: 'Lists your event types.',
    group: 'Event types',
    shape: 'bookingPage',
  },
  slots_list: {
    label: 'List slots',
    description: 'Lists available booking slots in a time range.',
    group: 'Slots',
    shape: 'slot',
  },
  booking_pages_check_username: {
    label: 'Check a username',
    description: 'Checks whether a profile username is available.',
    group: 'Booking pages',
    action: 'read',
    shape: 'usernameCheck',
  },
  schedules_list: {
    label: 'List schedules',
    description: 'Lists your working-hours schedules and those of the teams you manage.',
    group: 'Schedules',
    shape: 'schedule',
  },
  schedules_get: {
    label: 'Get a schedule',
    description: 'Retrieves a schedule by its ID.',
    group: 'Schedules',
    action: 'read',
    shape: 'schedule',
  },
  schedules_create: {
    label: 'Create a schedule',
    description: 'Creates a working-hours schedule.',
    group: 'Schedules',
    action: 'create',
    shape: 'schedule',
  },
  schedules_update: {
    label: 'Update a schedule',
    description: 'Updates a schedule; every booking page using it changes with it.',
    group: 'Schedules',
    action: 'update',
    shape: 'schedule',
  },
  schedules_delete: {
    label: 'Delete a schedule',
    description: 'Deletes a schedule no booking page uses.',
    group: 'Schedules',
    action: 'delete',
    shape: 'ok',
  },
  schedules_set_default: {
    label: 'Set the default schedule',
    description: 'Makes a schedule the default every booking page without its own follows.',
    group: 'Schedules',
    action: 'update',
    shape: 'schedule',
  },
};

// Module names as they exist in the live Make app (carly-dqs4v5). These were
// chosen by hand in the app builder and a module's name is fixed at creation,
// so they don't match this repo's file names — and `listBookingPages` doesn't
// even match the camelCase pattern the other thirteen follow. groups.json
// references modules by NAME, so it has to use these, not the file names.
const MAKE_MODULE_NAMES: Record<string, string> = {
  whoami: 'whoami',
  booking_pages_list: 'listBookingPages',
  // The original bookingPagesGet/bookingsGet were created as Search modules;
  // a get-by-ID should be an Action and Make fixes type at creation, so these
  // are the Action replacements. The originals are retired, not deleted — a
  // shared app can't drop a module.
  booking_pages_get: 'getBookingPage',
  booking_pages_create: 'bookingPagesCreate',
  booking_pages_update: 'bookingPagesUpdate',
  booking_pages_delete: 'bookingPagesDelete',
  bookings_list: 'bookingsList',
  bookings_get: 'getBooking',
  calendars_list: 'calendarsList',
  calendars_select: 'calendarsSelect',
  calendars_unselect: 'calendarsUnselect',
  event_types_list: 'eventTypesList',
  slots_list: 'slotsList',
  // Added 2026-08-29 (carly-cli 0.3.2); created in the live app under these
  // names by `npm run push:make`.
  booking_pages_check_username: 'bookingPagesCheckUsername',
  schedules_list: 'schedulesList',
  schedules_get: 'schedulesGet',
  schedules_create: 'schedulesCreate',
  schedules_update: 'schedulesUpdate',
  schedules_delete: 'schedulesDelete',
  schedules_set_default: 'schedulesSetDefault',
  make_api_call: 'makeApiCall',
};

// ---- Response interfaces ---------------------------------------------------
// Captured from live API responses (2026-07-29). `defaultColumns` only drives
// the CLI's table view, so it's far too narrow for Make — every module needs an
// interface matching its full actual output or downstream modules can't map
// fields. /booking-pages and /event-types return the identical object.

interface IField {
  name: string;
  type: string;
  label: string;
  spec?: unknown;
}

const ABBREVIATIONS = new Set(['id', 'uid', 'url', 'api', 'utc', 'crm']);

/**
 * Sentence case, with IDs and other abbreviations left uppercase. Handles both
 * the snake_case the API returns and the camelCase the command defs use, so
 * `event_type_id` and `eventTypeId` both render as "Event type ID".
 */
function outputLabel(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ABBREVIATIONS.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

const f = (name: string, type: string, spec?: unknown): IField => {
  const field: IField = { name, type, label: outputLabel(name) };
  if (spec !== undefined) field.spec = spec;
  return field;
};

// Nested shapes the API returns inside booking pages / bookings.
const AVAILABILITY_ROW = {
  type: 'collection',
  spec: [
    f('days', 'array', { type: 'number' }),
    f('start_time', 'text'),
    f('end_time', 'text'),
  ],
};
// A date override with zero windows is a fully blocked day — the empty array
// is meaningful, not a missing value.
const DATE_OVERRIDE_ROW = {
  type: 'collection',
  spec: [
    f('date', 'text'),
    f('windows', 'array', {
      type: 'collection',
      spec: [f('start_time', 'text'), f('end_time', 'text')],
    }),
  ],
};

const WIDGET_ROW = {
  type: 'collection',
  spec: [f('type', 'text'), f('label', 'text'), f('url', 'text')],
};
const ATTENDEE_ROW = {
  type: 'collection',
  spec: [
    f('name', 'text'),
    f('email', 'text'),
    f('phone', 'text'),
    f('company', 'text'),
    f('timezone', 'text'),
  ],
};

const RESPONSE_SHAPES: Record<string, IField[]> = {
  profile: [
    f('user', 'collection', [f('id', 'number'), f('email', 'text')]),
  ],
  bookingPage: [
    f('id', 'number'),
    f('username', 'text'),
    f('slug', 'text'),
    f('title', 'text'),
    f('description', 'text'),
    f('length', 'number'),
    f('is_active', 'boolean'),
    f('booking_url', 'text'),
    f('share_url', 'text'),
    f('timezone', 'text'),
    f('location', 'text'),
    f('video_provider', 'text'),
    f('calendar_key', 'text'),
    f('schedule_id', 'number'),
    f('min_notice_minutes', 'number'),
    f('max_days_ahead', 'number'),
    f('before_event_buffer', 'number'),
    f('after_event_buffer', 'number'),
    f('slot_interval', 'number'),
    f('event_name_template', 'text'),
    f('notification_email', 'text'),
    f('collect_phone', 'boolean'),
    f('collect_company', 'boolean'),
    f('availability', 'array', AVAILABILITY_ROW),
    f('date_overrides', 'array', DATE_OVERRIDE_ROW),
    f('availability_calendar_keys', 'array', { type: 'text' }),
    f('duration_options', 'array', { type: 'number' }),
    f('widgets', 'array', WIDGET_ROW),
    // Free-form per-page question definitions — structure varies by page, so
    // use Make's unknown-structure idiom (array with no spec).
    f('custom_questions', 'array'),
    f('created_at', 'date'),
    f('updated_at', 'date'),
  ],
  booking: [
    f('id', 'number'),
    f('uid', 'text'),
    f('status', 'text'),
    f('title', 'text'),
    f('start_time', 'date'),
    f('end_time', 'date'),
    f('username', 'text'),
    f('event_type_id', 'number'),
    f('event_type_slug', 'text'),
    f('notes', 'text'),
    f('cancellation_reason', 'text'),
    f('attendees', 'array', ATTENDEE_ROW),
    // Keyed by each page's custom question — unknown structure.
    f('custom_answers', 'array'),
    f('created_at', 'date'),
    f('updated_at', 'date'),
  ],
  calendar: [
    f('key', 'text'),
    f('provider', 'text'),
    f('account_email', 'text'),
    f('label', 'text'),
    f('selected', 'boolean'),
  ],
  slot: [f('date', 'text'), f('start', 'date'), f('end', 'date')],
  // Deactivation is a soft delete — the page stays listed with is_active false.
  ok: [f('ok', 'boolean')],
  usernameCheck: [f('available', 'boolean')],
  schedule: [
    f('id', 'number'),
    f('name', 'text'),
    f('timezone', 'text'),
    f('resolved_timezone', 'text'),
    f('is_default', 'boolean'),
    f('owner', 'collection', [f('kind', 'text'), f('user_id', 'number'), f('organization_id', 'number')]),
    f('summary', 'text'),
    f('availability', 'array', AVAILABILITY_ROW),
    f('date_overrides', 'array', DATE_OVERRIDE_ROW),
    f('can_edit', 'boolean'),
    // Pages using the schedule; shape varies by page kind, so no spec.
    f('used_by', 'array'),
  ],
};

// ---- Nested input parameters ----------------------------------------------
// These are modelled as real Make array parameters rather than text inputs run
// through parseJSON. Two reasons:
//
//  1. It's the building experience Make's reviewer asked for — users pick
//     fields instead of hand-writing JSON.
//  2. It's the safe one. PATCH semantics were measured against the live API:
//       key omitted -> all three preserved
//       null        -> custom_questions and duration_options WIPED
//                      (availability happens to be guarded server-side)
//       []          -> all three WIPED, including availability, which leaves
//                      the page unbookable
//     parseJSON over an empty text input yields null, so an untouched field
//     silently destroyed data. An untouched *array* parameter is absent from
//     `parameters` entirely, so the key never reaches the body.
//
// A user who explicitly adds zero items still sends [] — that case really does
// clear the field, which is the correct reading of an explicit empty list.
const ARRAY_PARAM_SPECS: Record<string, unknown> = {
  availability: {
    type: 'collection',
    spec: [
      { name: 'days', type: 'array', label: 'Days', spec: { type: 'number' }, help: 'Sun=0 … Sat=6.' },
      { name: 'start_time', type: 'text', label: 'Start time', help: 'HH:MM, 24-hour.' },
      { name: 'end_time', type: 'text', label: 'End time', help: 'HH:MM, 24-hour.' },
    ],
  },
  // Windows is an array of collections nested inside a collection. Leaving it
  // empty is the "block this whole date" case, so it carries no `required`.
  dateOverrides: {
    type: 'collection',
    spec: [
      { name: 'date', type: 'text', label: 'Date', required: true, help: 'YYYY-MM-DD.' },
      {
        name: 'windows',
        type: 'array',
        label: 'Hours',
        help: 'Leave empty to block the whole date.',
        spec: {
          type: 'collection',
          spec: [
            { name: 'start_time', type: 'text', label: 'Start time', help: 'HH:MM, 24-hour.' },
            { name: 'end_time', type: 'text', label: 'End time', help: 'HH:MM, 24-hour.' },
          ],
        },
      },
    ],
  },
  availabilityCalendarKeys: {
    type: 'collection',
    spec: [
      { name: 'provider', type: 'text', label: 'Provider' },
      { name: 'integration_id', type: 'uinteger', label: 'Integration ID' },
      { name: 'calendar_id', type: 'text', label: 'Calendar ID' },
    ],
  },
  customQuestions: {
    type: 'collection',
    spec: [
      { name: 'label', type: 'text', label: 'Label', required: true },
      { name: 'type', type: 'text', label: 'Type', required: true },
      { name: 'required', type: 'boolean', label: 'Required' },
    ],
  },
  durationOptions: { type: 'number' },
  // Five widget variants, each with its own required fields, normalised and
  // validated server-side. Rather than invent a union spec that would send
  // junk keys, use Make's unknown-structure idiom: an array with no spec.
  widgets: null,
};

// The CLI help for these fields talks about hand-written JSON/CSV, which no
// longer describes the Make experience now that they're real array parameters.
const ARRAY_PARAM_HELP: Record<string, string> = {
  availability: 'Weekly availability. Each row is a set of days plus a start and end time.',
  dateOverrides:
    'One-off exceptions to the weekly hours. Each entry replaces the weekly pattern for that single date — add hours to change it, or leave the hours empty to block the date entirely.',
  availabilityCalendarKeys:
    'Calendars whose events block availability on this page. Distinct from the target calendar, which is where the booking gets written.',
  customQuestions: 'Questions asked of the guest when they book.',
  durationOptions: 'Bookable meeting lengths in minutes.',
  widgets:
    'Page content blocks, max 20. Each block is an object with a type — video, image, text, link or testimonial — plus that type\'s fields.',
};

// ---- Zod helpers -----------------------------------------------------------

function unwrap(schema: any): any {
  let s = schema;
  for (let i = 0; i < 10 && s?._def; i++) {
    const t = s._def.typeName;
    if (t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault') s = s._def.innerType;
    else if (t === 'ZodEffects') s = s._def.schema;
    else break;
  }
  return s;
}
function isJson(schema: any): boolean {
  const t = unwrap(schema)?._def?.typeName;
  return t === 'ZodArray' || t === 'ZodObject' || t === 'ZodRecord';
}
function isOptional(schema: any): boolean {
  const t = schema?._def?.typeName;
  return t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodNullable';
}
function makeType(field: string, schema: any): string {
  if (/time$/i.test(field)) return 'date';
  const t = unwrap(schema)?._def?.typeName;
  if (t === 'ZodNumber') return 'number';
  if (t === 'ZodBoolean') return 'boolean';
  if (t === 'ZodUnion') {
    const opts: any[] = unwrap(schema)?._def?.options ?? [];
    if (opts.some((o) => unwrap(o)?._def?.typeName === 'ZodBoolean')) return 'boolean';
  }
  if (isJson(schema)) return 'text'; // JSON string, parsed via {{parse()}} in communication
  return 'text';
}
function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface FieldModel {
  field: string;
  location: 'path' | 'query' | 'body';
  type: string;
  required: boolean;
  json: boolean;
  help: string;
}
function fieldsFor(cmd: CommandDefinition): FieldModel[] {
  const shape: Record<string, any> = (cmd.inputSchema as any).shape ?? {};
  const out: FieldModel[] = [];
  const seen = new Set<string>();
  const push = (field: string, help: string, requiredHint?: boolean) => {
    const location = cmd.fieldMappings[field];
    if (!location || seen.has(field)) return;
    seen.add(field);
    const z = shape[field];
    out.push({
      field,
      location,
      type: makeType(field, z),
      required: requiredHint ?? !isOptional(z),
      json: isJson(z),
      help,
    });
  };
  for (const arg of cmd.cliMappings.args ?? []) push(arg.field, '', arg.required);
  for (const opt of cmd.cliMappings.options ?? []) push(opt.field, opt.description ?? '');
  return out;
}

// ---- Build module JSON -----------------------------------------------------

function buildModule(cmd: CommandDefinition): Record<string, unknown> {
  const meta = MODULE_META[cmd.name];
  if (!meta) throw new Error(`No MODULE_META entry for "${cmd.name}" — add one.`);
  const isSearch = cmd.subcommand === 'list';
  const fields = fieldsFor(cmd);
  const method = cmd.endpoint.method.toUpperCase();

  let url = cmd.endpoint.path;
  const qs: Record<string, string> = {};
  const body: Record<string, unknown> = {};

  for (const f of fields) {
    if (f.location === 'path') {
      url = url.replace(`{${f.field}}`, `{{parameters.${f.field}}}`);
    } else if (f.location === 'query') {
      qs[f.field] = `{{parameters.${f.field}}}`;
    } else if (f.location === 'body') {
      // Array parameters map straight through; only legacy JSON-as-text fields
      // still need parseJSON. See ARRAY_PARAM_SPECS for why that matters.
      body[f.field] =
        f.json && !(f.field in ARRAY_PARAM_SPECS)
          ? `{{parseJSON(parameters.${f.field})}}`
          : `{{parameters.${f.field}}}`;
    }
  }
  for (const [k, v] of Object.entries(CONSTANT_BODY[cmd.name] ?? {})) body[k] = v;

  const communication: Record<string, unknown> = { url, method };
  if (Object.keys(qs).length) communication.qs = qs;
  if (Object.keys(body).length) communication.body = body;
  // List endpoints return { items: [...] }; emit each item as a bundle. Search
  // modules must also cap the bundle count via response.limit.
  communication.response = isSearch
    ? { iterate: '{{body.items}}', output: '{{item}}', limit: '{{parameters.limit}}' }
    : { output: '{{body}}' };

  // `limit` is a plain query option on some commands; Make wants it typed
  // uinteger, optional, defaulted and placed last on every search module.
  const mappableParameters = fields
    .filter((f) => !(isSearch && f.field === 'limit'))
    .map((f) => {
      const isArrayParam = f.field in ARRAY_PARAM_SPECS;
      const p: Record<string, unknown> = {
        name: f.field,
        type: isArrayParam ? 'array' : f.type,
        label: outputLabel(f.field),
      };
      // A null spec is deliberate — Make's unknown-structure idiom.
      if (isArrayParam && ARRAY_PARAM_SPECS[f.field] !== null) {
        p.spec = ARRAY_PARAM_SPECS[f.field];
      }
      if (f.required) p.required = true;
      const help = ARRAY_PARAM_HELP[f.field] ?? f.help;
      if (help) p.help = help;
      return p;
    });
  if (isSearch) {
    mappableParameters.push({
      name: 'limit',
      type: 'uinteger',
      label: 'Limit',
      help: `Maximum number of ${meta.group.toLowerCase()} to return.`,
      default: 10,
    });
  }

  const metadata: Record<string, unknown> = {
    label: meta.label,
    description: meta.description,
  };
  if (meta.action) metadata.action = meta.action;

  return {
    metadata,
    connection: 'carly',
    communication,
    mappableParameters,
    interface: meta.shape ? RESPONSE_SHAPES[meta.shape] : [],
  };
}

// ---- Emit ------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../carly-make');
mkdirSync(resolve(outDir, 'modules'), { recursive: true });
mkdirSync(resolve(outDir, 'connection'), { recursive: true });

const write = (rel: string, data: unknown) =>
  writeFileSync(resolve(outDir, rel), JSON.stringify(data, null, 2) + '\n');

// The API reports failures as {"code": "...", "error": "..."} — there is no
// `message` field, so "{{body.message}}" renders an empty error. Read
// body.error first, fall back to body.message, then the bare status code.
const ERROR_MESSAGE = '[{{statusCode}}] {{ifempty(body.error, ifempty(body.message, statusCode))}}';

// BASE — baseUrl + bearer auth + sanitize the auth header from logs.
write('base.imljson', {
  baseUrl: BASE_URL,
  headers: { authorization: 'Bearer {{connection.apiKey}}' },
  response: { error: { message: ERROR_MESSAGE } },
  log: { sanitize: ['request.headers.authorization'] },
});

// CONNECTION — apiKey param + verify via /whoami.
write('connection/parameters.imljson', [
  {
    name: 'apiKey',
    type: 'password',
    label: 'API Key',
    required: true,
    editable: true,
    help: 'Generate an API key in the Carly dashboard. Write actions need the booking_pages:write scope.',
  },
]);
write('connection/communication.imljson', {
  url: `${BASE_URL}/whoami`,
  headers: { authorization: 'Bearer {{parameters.apiKey}}' },
  response: {
    valid: '{{statusCode === 200}}',
    error: { message: ERROR_MESSAGE },
    // Label each connection by the account's email for easy identification.
    metadata: { type: 'email', value: '{{body.user.email}}' },
  },
  log: { sanitize: ['request.headers.authorization'] },
});

const written: string[] = [];
for (const cmd of allCommands) {
  // calendars select/unselect share a path but are distinct Make modules (the
  // selected constant differs), so keep both.
  write(`modules/${cmd.name}.imljson`, buildModule(cmd));
  written.push(cmd.name);
}

// Universal module — mandatory for Make review. Lets users make an arbitrary
// authorized call to any Carly endpoint.
write('modules/make_api_call.imljson', {
  metadata: {
    label: 'Make an API call',
    description: 'Performs an arbitrary authorized call to the Carly API.',
  },
  connection: 'carly',
  communication: {
    url: '{{parameters.url}}',
    method: '{{parameters.method}}',
    // The `{{...}}` spread key MERGES these into the request rather than
    // replacing — so base's Authorization header is preserved.
    headers: { '{{...}}': '{{toCollection(parameters.headers, "key", "value")}}' },
    qs: { '{{...}}': '{{toCollection(parameters.qs, "key", "value")}}' },
    body: '{{parameters.body}}',
    type: 'text',
    response: {
      output: { body: '{{body}}', headers: '{{headers}}', statusCode: '{{statusCode}}' },
    },
  },
  mappableParameters: [
    {
      name: 'url',
      type: 'text',
      label: 'URL',
      required: true,
      help: `Relative to ${BASE_URL}, e.g. /bookings or /booking-pages/42`,
    },
    {
      name: 'method',
      type: 'select',
      label: 'Method',
      required: true,
      default: 'GET',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({ label: m, value: m })),
    },
    {
      name: 'headers',
      type: 'array',
      label: 'Headers',
      help: "You don't need to add an authorization header — the app adds it for you.",
      spec: {
        type: 'collection',
        spec: [
          { name: 'key', type: 'text', label: 'Key' },
          { name: 'value', type: 'text', label: 'Value' },
        ],
      },
    },
    {
      name: 'qs',
      type: 'array',
      label: 'Query String',
      spec: {
        type: 'collection',
        spec: [
          { name: 'key', type: 'text', label: 'Key' },
          { name: 'value', type: 'text', label: 'Value' },
        ],
      },
    },
    { name: 'body', type: 'any', label: 'Body' },
  ],
  interface: [],
});
written.push('make_api_call (universal)');

// GROUPS — Make renders modules ungrouped ("Other") without this file. Order
// within a group is List, then Get, Create, Update, Delete.
// https://developers.make.com/custom-apps-documentation/app-components/groups
const GROUP_ORDER = ['Booking pages', 'Bookings', 'Event types', 'Slots', 'Calendars', 'Profile'];
const RANK = ['list', 'get', 'create', 'update', 'delete', 'select', 'unselect'];

const groups = GROUP_ORDER.map((label) => ({
  label,
  modules: allCommands
    .filter((c) => MODULE_META[c.name]?.group === label)
    .sort((a, b) => RANK.indexOf(a.subcommand) - RANK.indexOf(b.subcommand))
    .map((c) => {
      const live = MAKE_MODULE_NAMES[c.name];
      if (!live) throw new Error(`No MAKE_MODULE_NAMES entry for "${c.name}" — add one.`);
      return live;
    }),
})).filter((g) => g.modules.length > 0);
// The reviewer asked for "Other" to be kept for the universal module rather
// than dropping it — an omitted module would not surface in the UI at all.
// Retired Search-typed get-by-ID modules, superseded by getBookingPage /
// getBooking. They're hidden and deprecated but a shared app can't delete a
// module, and Make appends any ungrouped module to "Other" anyway — so list
// them explicitly, otherwise every push reports a spurious groups mismatch.
const RETIRED_MODULES = ['bookingsGet', 'bookingPagesGet'];
groups.push({ label: 'Other', modules: [MAKE_MODULE_NAMES.make_api_call, ...RETIRED_MODULES] });
write('groups.json', groups);

// MANIFEST — what `npm run push:make` needs to talk to the live app: which
// repo file maps to which live module name, plus the metadata that lives on
// the module record itself rather than in a section file.
write('make-manifest.json', {
  zone: 'us2',
  app: 'carly-dqs4v5',
  version: 1,
  modules: [
    ...allCommands.map((c) => ({
      file: `modules/${c.name}.imljson`,
      name: MAKE_MODULE_NAMES[c.name],
      label: MODULE_META[c.name].label,
      description: MODULE_META[c.name].description,
      crud: MODULE_META[c.name].action ?? null,
      // Make fixes a module's type at creation; these two are still Search
      // modules in the live app and need recreating as Actions by hand.
      wantsType: c.subcommand === 'list' ? 'search' : 'action',
    })),
    {
      file: 'modules/make_api_call.imljson',
      name: MAKE_MODULE_NAMES.make_api_call,
      label: 'Make an API call',
      description: 'Performs an arbitrary authorized call to the Carly API.',
      crud: null,
      wantsType: 'universal',
    },
  ],
});

console.log(
  `Generated ${outDir}\n` +
    `  base.imljson, connection/, groups.json, ${written.length} modules:\n    ${written.join(', ')}\n` +
    `  groups: ${groups.map((g) => `${g.label} (${g.modules.length})`).join(', ')}`,
);
