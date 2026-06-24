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
      body[f.field] = f.json ? `{{parse(parameters.${f.field})}}` : `{{parameters.${f.field}}}`;
    }
  }
  for (const [k, v] of Object.entries(CONSTANT_BODY[cmd.name] ?? {})) body[k] = v;

  const communication: Record<string, unknown> = { url, method };
  if (Object.keys(qs).length) communication.qs = qs;
  if (Object.keys(body).length) communication.body = body;
  // List endpoints return { items: [...] }; emit each item as a bundle.
  communication.response =
    cmd.subcommand === 'list'
      ? { iterate: '{{body.items}}', output: '{{item}}' }
      : { output: '{{body}}' };

  const mappableParameters = fields.map((f) => {
    const p: Record<string, unknown> = { name: f.field, type: f.type, label: humanize(f.field) };
    if (f.required) p.required = true;
    if (f.help) p.help = f.help;
    return p;
  });

  return {
    metadata: {
      label: cmd.description.split('.')[0],
      description: cmd.description,
    },
    connection: 'carly',
    communication,
    mappableParameters,
    interface: (cmd.defaultColumns ?? []).map((c) => ({
      name: c,
      label: humanize(c),
      type: /(_at|_time)$|^date$|^start$|^end$/.test(c)
        ? 'date'
        : /^is_|^selected$/.test(c)
          ? 'boolean'
          : /^id$|_id$|^length$/.test(c)
            ? 'number'
            : 'text',
    })),
  };
}

// ---- Emit ------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../carly-make');
mkdirSync(resolve(outDir, 'modules'), { recursive: true });
mkdirSync(resolve(outDir, 'connection'), { recursive: true });

const write = (rel: string, data: unknown) =>
  writeFileSync(resolve(outDir, rel), JSON.stringify(data, null, 2) + '\n');

// BASE — baseUrl + bearer auth + sanitize the auth header from logs.
write('base.imljson', {
  baseUrl: BASE_URL,
  headers: { authorization: 'Bearer {{connection.apiKey}}' },
  response: { error: { message: '{{body.message}}' } },
  log: { sanitize: ['request.headers.authorization'] },
});

// CONNECTION — apiKey param + verify via /whoami.
write('connection/parameters.imljson', [
  {
    name: 'apiKey',
    type: 'text',
    label: 'API Key',
    required: true,
    help: 'Generate an API key in the Carly dashboard. Write actions need the booking_pages:write scope.',
  },
]);
write('connection/communication.imljson', {
  url: `${BASE_URL}/whoami`,
  headers: { authorization: 'Bearer {{parameters.apiKey}}' },
  response: { error: { message: '[{{statusCode}}] {{body.message}}' } },
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
    label: 'Make an API Call',
    description: 'Perform an arbitrary authorized call to the Carly API.',
  },
  connection: 'carly',
  communication: {
    url: '{{parameters.url}}',
    method: '{{parameters.method}}',
    headers: '{{toCollection(parameters.headers, "key", "value")}}',
    qs: '{{toCollection(parameters.qs, "key", "value")}}',
    body: '{{parameters.body}}',
    response: { output: '{{body}}' },
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

console.log(
  `Generated ${outDir}\n` +
    `  base.imljson, connection/, ${written.length} modules:\n    ${written.join(', ')}`,
);
