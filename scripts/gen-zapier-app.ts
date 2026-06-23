/**
 * Codegen: emit a Zapier Platform (CLI) integration from Carly's command defs.
 *
 *   npm run gen:zapier   ->   ../carly-zapier/index.js
 *
 * Single source of truth — the same `CommandDefinition`s that drive the CLI,
 * the MCP server, and the n8n node also drive the Zapier app. Mapping to
 * Zapier's trigger/create/search model:
 *   GET list/get   -> searches  (and bookings list also seeds a polling trigger)
 *   POST/PATCH/DEL -> creates   (actions)
 *   whoami         -> auth test (not exposed as an action)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { profileCommands } from '../src/commands/profile/index.js';
import { calendarsCommands } from '../src/commands/calendars/index.js';
import { bookingPagesCommands } from '../src/commands/booking-pages/index.js';
import { eventTypesCommands } from '../src/commands/event-types/index.js';
import { slotsCommands } from '../src/commands/slots/index.js';
import { bookingsCommands } from '../src/commands/bookings/index.js';
import type { CommandDefinition } from '../src/core/types.js';

const allCommands: CommandDefinition[] = [
  ...profileCommands,
  ...calendarsCommands,
  ...bookingPagesCommands,
  ...eventTypesCommands,
  ...slotsCommands,
  ...bookingsCommands,
];

const BASE_URL = 'https://dashboard.carlyassistant.com/api/v1';

const CONSTANT_BODY: Record<string, Record<string, unknown>> = {
  calendars_select: { selected: true },
  calendars_unselect: { selected: false },
};

const NOUNS: Record<string, string> = {
  profile: 'Profile',
  calendars: 'Calendar',
  'booking-pages': 'Booking Page',
  'event-types': 'Event Type',
  slots: 'Slot',
  bookings: 'Booking',
};

// ---- Zod introspection (same approach as gen-n8n-node.ts) -----------------

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
function isJsonType(schema: any): boolean {
  const t = unwrap(schema)?._def?.typeName;
  return t === 'ZodArray' || t === 'ZodObject' || t === 'ZodRecord';
}
function isOptional(schema: any): boolean {
  const t = schema?._def?.typeName;
  return t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodNullable';
}
function zapierType(field: string, schema: any): string {
  const t = unwrap(schema)?._def?.typeName;
  if (/time$/i.test(field)) return 'datetime';
  if (t === 'ZodNumber') return 'integer';
  if (t === 'ZodBoolean') return 'boolean';
  if (t === 'ZodUnion') {
    const opts: any[] = unwrap(schema)?._def?.options ?? [];
    if (opts.some((o) => unwrap(o)?._def?.typeName === 'ZodBoolean')) return 'boolean';
  }
  if (isJsonType(schema)) return 'text';
  return 'string';
}

function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Per-command field model ----------------------------------------------

interface FieldModel {
  field: string;
  location: 'path' | 'query' | 'body';
  type: string;
  required: boolean;
  json: boolean;
  helpText: string;
}

function fieldsFor(cmd: CommandDefinition): FieldModel[] {
  const shape: Record<string, any> = (cmd.inputSchema as any).shape ?? {};
  const out: FieldModel[] = [];
  const seen = new Set<string>();
  const push = (field: string, helpText: string, requiredHint?: boolean) => {
    const location = cmd.fieldMappings[field];
    if (!location || seen.has(field)) return;
    seen.add(field);
    const z = shape[field];
    out.push({
      field,
      location,
      type: zapierType(field, z),
      required: requiredHint ?? !isOptional(z),
      json: isJsonType(z),
      helpText,
    });
  };
  // Path/id args get no helpText — a label like "Event Type Id" plus identical
  // help text trips Zapier's redundant-help-text check (D011).
  for (const arg of cmd.cliMappings.args ?? []) push(arg.field, '', arg.required);
  for (const opt of cmd.cliMappings.options ?? []) push(opt.field, opt.description ?? humanize(opt.field));
  return out;
}

// ---- Code generation -------------------------------------------------------

function jsString(s: string): string {
  return JSON.stringify(s);
}

function inputFieldsLiteral(fields: FieldModel[]): string {
  const items = fields.map((f) => {
    const parts = [
      `key: ${jsString(f.field)}`,
      `label: ${jsString(humanize(f.field))}`,
      `type: ${jsString(f.type)}`,
    ];
    if (f.required) parts.push('required: true');
    // Skip help text that merely repeats the label (Zapier D011).
    if (f.helpText && f.helpText !== humanize(f.field)) parts.push(`helpText: ${jsString(f.helpText)}`);
    return `    { ${parts.join(', ')} }`;
  });
  return `[\n${items.join(',\n')}\n  ]`;
}

/** Build the request inside a perform body. Returns lines of JS. */
function performBody(cmd: CommandDefinition, returns: 'array' | 'object'): string {
  const method = cmd.endpoint.method.toUpperCase();
  const fields = fieldsFor(cmd);

  // URL with path-param interpolation.
  let urlExpr = cmd.endpoint.path;
  for (const f of fields) {
    if (f.location === 'path') {
      urlExpr = urlExpr.replace(`{${f.field}}`, '${encodeURIComponent(i.' + f.field + ')}');
    }
  }
  const url = '`' + '${BASE_URL}' + urlExpr + '`';

  const lines: string[] = ['    const i = bundle.inputData || {};'];

  const queryFields = fields.filter((f) => f.location === 'query');
  const bodyFields = fields.filter((f) => f.location === 'body');
  const constBody = CONSTANT_BODY[cmd.name];

  if (queryFields.length) {
    lines.push('    const params = {};');
    for (const f of queryFields) {
      lines.push(`    if (i.${f.field} !== undefined && i.${f.field} !== '') params.${f.field} = i.${f.field};`);
    }
  }
  if (bodyFields.length || constBody) {
    lines.push('    const body = {};');
    for (const f of bodyFields) {
      const val = f.json ? `parseMaybeJson(i.${f.field})` : `i.${f.field}`;
      lines.push(`    if (i.${f.field} !== undefined && i.${f.field} !== '') body.${f.field} = ${val};`);
    }
    if (constBody) {
      for (const [k, v] of Object.entries(constBody)) lines.push(`    body.${k} = ${JSON.stringify(v)};`);
    }
  }

  const reqOpts = [`url: ${url}`, `method: ${jsString(method)}`];
  if (queryFields.length) reqOpts.push('params');
  if (bodyFields.length || constBody) reqOpts.push('body');

  lines.push(`    const response = await z.request({ ${reqOpts.join(', ')} });`);
  lines.push('    response.throwForStatus();');
  if (returns === 'array') lines.push('    return toArray(response.data);');
  else lines.push('    return response.data || { success: true };');

  return lines.join('\n');
}

const LABELS: Record<string, (noun: string) => string> = {
  list: (n) => `Find ${n}s`,
  get: (n) => `Find ${n} by ID`,
  create: (n) => `Create ${n}`,
  update: (n) => `Update ${n}`,
  delete: (n) => `Deactivate ${n}`,
  select: () => 'Add Calendar To Availability',
  unselect: () => 'Remove Calendar From Availability',
  whoami: () => 'Get Profile',
};

function sampleLiteral(cmd: CommandDefinition): string {
  const cols = cmd.defaultColumns ?? [];
  const obj: Record<string, unknown> = { id: 1 };
  for (const c of cols) {
    if (c === 'id') continue;
    obj[c] = /time$/i.test(c) ? '2026-05-01T09:00:00Z' : `sample ${c}`;
  }
  return JSON.stringify(obj);
}

function operationObject(cmd: CommandDefinition, returns: 'array' | 'object'): string {
  const noun = NOUNS[cmd.group] ?? humanize(cmd.group);
  const label = (LABELS[cmd.subcommand] ?? ((n: string) => `${humanize(cmd.subcommand)} ${n}`))(noun);
  const fields = fieldsFor(cmd);
  return `{
  key: ${jsString(cmd.name)},
  noun: ${jsString(noun)},
  display: {
    label: ${jsString(label)},
    description: ${jsString(cmd.description)},
  },
  operation: {
    inputFields: ${inputFieldsLiteral(fields)},
    perform: async (z, bundle) => {
${performBody(cmd, returns)}
    },
    sample: ${sampleLiteral(cmd)},
  },
}`;
}

// New Booking polling trigger (seeded from bookings list).
function newBookingTrigger(): string {
  return `{
  key: 'new_booking',
  noun: 'Booking',
  display: {
    label: 'New Booking',
    description: 'Triggers when a new booking is created.',
  },
  operation: {
    type: 'polling',
    inputFields: [
      { key: 'status', label: 'Status', type: 'string', helpText: 'Optional: only bookings with this status.' },
    ],
    perform: async (z, bundle) => {
      const params = { limit: 100 };
      if (bundle.inputData && bundle.inputData.status) params.status = bundle.inputData.status;
      const response = await z.request({ url: \`\${BASE_URL}/bookings\`, method: 'GET', params });
      response.throwForStatus();
      // Zapier dedupes by \`id\`; Carly bookings are keyed by \`uid\`.
      return toArray(response.data).map((b) => ({ id: String(b.uid || b.id || ''), ...b }));
    },
    sample: { id: 'abc123xyz', uid: 'abc123xyz', status: 'accepted', start_time: '2026-05-01T09:00:00Z', end_time: '2026-05-01T09:30:00Z', title: 'Intro call' },
  },
}`;
}

// ---- Classify + assemble ---------------------------------------------------

const searches: string[] = [];
const creates: string[] = [];
const triggers: string[] = [newBookingTrigger()];

for (const cmd of allCommands) {
  if (cmd.name === 'whoami') continue; // used by auth test
  const method = cmd.endpoint.method.toUpperCase();
  if (method === 'GET') searches.push(operationObject(cmd, 'array'));
  else creates.push(operationObject(cmd, 'object'));
}

const keyOf = (objLiteral: string) => {
  const m = objLiteral.match(/key:\s*"([^"]+)"|key:\s*'([^']+)'/)!;
  return m[1] ?? m[2];
};
const mapEntries = (objs: string[]) =>
  objs.map((o) => `  ${JSON.stringify(keyOf(o))}: ${o.replace(/\n/g, '\n  ')},`).join('\n');

const banner = `// AUTO-GENERATED by carly-cli/scripts/gen-zapier-app.ts — DO NOT EDIT BY HAND.
// Regenerate with \`npm run gen:zapier\` from the carly-cli repo.
// Source of truth: carly-cli/src/commands/**.
'use strict';
`;

const helpers = `
const BASE_URL = ${jsString(BASE_URL)};

const addAuthHeader = (request, z, bundle) => {
  request.headers = request.headers || {};
  if (bundle.authData && bundle.authData.apiKey) {
    request.headers.Authorization = 'Bearer ' + bundle.authData.apiKey;
  }
  request.headers.Accept = 'application/json';
  return request;
};

// Normalize a Carly response to an array (list endpoints may return a bare
// array or an enveloped object; a single object is wrapped).
const toArray = (data) => {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    for (const k of ['data', 'results', 'items', 'bookings', 'booking_pages', 'event_types', 'calendars', 'slots']) {
      if (Array.isArray(data[k])) return data[k];
    }
    return [data];
  }
  return [];
};

// Zapier passes JSON-array fields as strings; parse them back.
const parseMaybeJson = (v) => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.startsWith('[') || t.startsWith('{')) { try { return JSON.parse(t); } catch (e) { return v; } }
  return v;
};

const authentication = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      required: true,
      type: 'password',
      helpText: 'Generate an API key in the Carly dashboard under Booking Pages \\u2192 "Generate API key". Create/update/delete and calendar actions need a key with the booking_pages:write scope.',
    },
  ],
  test: async (z, bundle) => {
    const response = await z.request({ url: BASE_URL + '/whoami' });
    response.throwForStatus();
    return response.data;
  },
  connectionLabel: '{{json.user.email}}',
};
`;

const body = `${banner}${helpers}
const triggers = {
${mapEntries(triggers)}
};

const creates = {
${mapEntries(creates)}
};

const searches = {
${mapEntries(searches)}
};

const App = {
  version: require('./package.json').version,
  platformVersion: require('zapier-platform-core').version,
  authentication,
  beforeRequest: [addAuthHeader],
  afterResponse: [],
  triggers,
  creates,
  searches,
};

module.exports = App;
`;

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../../carly-zapier/index.js');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, body);

console.log(
  `Generated ${outPath}\n` +
    `  triggers: ${triggers.length} (new_booking)\n` +
    `  creates:  ${creates.length}\n` +
    `  searches: ${searches.length}`,
);
