/**
 * Codegen: emit an OpenAPI 3.1 spec from Carly's CLI command definitions.
 *
 *   npm run gen:openapi   ->   ../use_carly_landing/public/openapi.json
 *
 * Single source of truth — the same `CommandDefinition`s that drive the CLI,
 * MCP server, n8n node, and Zapier app also drive the OpenAPI spec. The spec
 * powers ChatGPT GPT Actions, Swagger/Redoc on the /developers page, and any
 * other OpenAPI-consuming tool.
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

const SERVER_URL = 'https://dashboard.carlyassistant.com/api/v1';

// ---- Zod -> OpenAPI schema -------------------------------------------------

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
function isOptional(schema: any): boolean {
  const t = schema?._def?.typeName;
  return t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodNullable';
}

function schemaFromZod(schema: any, field: string): Record<string, unknown> {
  const s = unwrap(schema);
  const t = s?._def?.typeName;
  let out: Record<string, unknown>;
  if (t === 'ZodNumber') out = { type: 'integer' };
  else if (t === 'ZodBoolean') out = { type: 'boolean' };
  else if (t === 'ZodArray') out = { type: 'array', items: {} };
  else if (t === 'ZodObject' || t === 'ZodRecord') out = { type: 'object' };
  else if (t === 'ZodEnum') out = { type: 'string', enum: s._def.values };
  else if (t === 'ZodUnion') {
    const opts: any[] = s._def.options ?? [];
    out = opts.some((o) => unwrap(o)?._def?.typeName === 'ZodBoolean')
      ? { type: 'boolean' }
      : { type: 'string' };
  } else out = { type: 'string' };
  if (out.type === 'string' && /time$/i.test(field)) out.format = 'date-time';
  return out;
}

// Fields present in fieldMappings but not the Zod shape (e.g. the injected
// `selected` constant on calendars/select) — infer a schema from the name.
function inferSchema(field: string): Record<string, unknown> {
  if (field === 'selected') return { type: 'boolean' };
  if (/^id$|Id$|_id$/.test(field)) return { type: 'integer' };
  if (/time$/i.test(field)) return { type: 'string', format: 'date-time' };
  return { type: 'string' };
}

function humanize(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Build operations ------------------------------------------------------

function fieldSchema(cmd: CommandDefinition, field: string): Record<string, unknown> {
  const shape: Record<string, any> = (cmd.inputSchema as any).shape ?? {};
  return field in shape ? schemaFromZod(shape[field], field) : inferSchema(field);
}
function isRequired(cmd: CommandDefinition, field: string): boolean {
  if (cmd.fieldMappings[field] === 'path') return true;
  const shape: Record<string, any> = (cmd.inputSchema as any).shape ?? {};
  if (!(field in shape)) return true; // injected constant -> always sent
  return !isOptional(shape[field]);
}

// Descriptions to override for merged endpoints.
const PATH_DESCRIPTION_OVERRIDE: Record<string, string> = {
  'POST /calendars/select':
    'Toggle whether a calendar counts against booking-page availability. Send selected=true to add it, selected=false to remove it. Requires the booking_pages:write scope.',
};

function buildOperation(cmd: CommandDefinition): Record<string, unknown> {
  const pathParams: any[] = [];
  const queryParams: any[] = [];
  const bodyProps: Record<string, unknown> = {};
  const bodyRequired: string[] = [];

  for (const [field, loc] of Object.entries(cmd.fieldMappings)) {
    const schema = fieldSchema(cmd, field);
    const required = isRequired(cmd, field);
    if (loc === 'path') {
      pathParams.push({ name: field, in: 'path', required: true, schema });
    } else if (loc === 'query') {
      queryParams.push({ name: field, in: 'query', required, schema });
    } else if (loc === 'body') {
      bodyProps[field] = schema;
      if (required) bodyRequired.push(field);
    }
  }

  const key = `${cmd.endpoint.method.toUpperCase()} ${cmd.endpoint.path}`;
  const op: Record<string, unknown> = {
    operationId: cmd.name,
    summary: cmd.description.split('.')[0],
    description: PATH_DESCRIPTION_OVERRIDE[key] ?? cmd.description,
    tags: [humanize(cmd.group)],
    responses: {
      '200': { description: 'Successful response' },
      '401': { description: 'Authentication failed (missing or invalid API key)' },
      default: {
        description: 'Error',
        content: {
          'application/json': {
            schema: { type: 'object', properties: { message: { type: 'string' } } },
          },
        },
      },
    },
  };

  const params = [...pathParams, ...queryParams];
  if (params.length) op.parameters = params;
  if (Object.keys(bodyProps).length) {
    op.requestBody = {
      required: bodyRequired.length > 0,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: bodyProps,
            ...(bodyRequired.length ? { required: bodyRequired } : {}),
          },
        },
      },
    };
  }
  return op;
}

const TAG_DESCRIPTIONS: Record<string, string> = {
  Profile: 'Identify the account an API key belongs to.',
  Calendars: 'List connected calendars and control which ones count against availability.',
  'Booking Pages': 'Create and manage bookable event types (public booking links).',
  'Event Types': "Read event types for the caller or a public profile.",
  Slots: 'Query bookable availability.',
  Bookings: 'Read scheduled bookings.',
};

const paths: Record<string, Record<string, unknown>> = {};
let merged = 0;
for (const cmd of allCommands) {
  const method = cmd.endpoint.method.toLowerCase();
  const p = cmd.endpoint.path;
  paths[p] = paths[p] ?? {};
  if (paths[p][method]) {
    // Same method+path already emitted (e.g. calendars select/unselect both
    // POST /calendars/select) — they share an identical wire contract, skip.
    merged++;
    continue;
  }
  paths[p][method] = buildOperation(cmd);
}

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'Carly API',
    version: '1.0.0',
    description:
      'The Carly REST API — booking pages, event types, calendars, bookings, and availability slots. ' +
      'Authenticate with a Bearer API key generated in the Carly dashboard (Authorization: Bearer <key>). ' +
      'Write operations require a key with the booking_pages:write scope.',
    contact: { name: 'Carly', url: 'https://www.usecarly.com/developers' },
  },
  servers: [{ url: SERVER_URL, description: 'Production' }],
  security: [{ bearerAuth: [] }],
  tags: [...new Set(allCommands.map((c) => humanize(c.group)))].map((name) => ({
    name,
    description: TAG_DESCRIPTIONS[name] ?? `${name} operations`,
  })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'Carly API key' },
    },
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../../use_carly_landing/public/openapi.json');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(spec, null, 2) + '\n');

const opCount = Object.values(paths).reduce((n, m) => n + Object.keys(m).length, 0);
console.log(
  `Generated ${outPath}\n` +
    `  ${Object.keys(paths).length} paths, ${opCount} operations` +
    (merged ? ` (${merged} merged duplicate method+path)` : ''),
);
