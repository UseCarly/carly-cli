/**
 * Codegen: emit the n8n declarative node from Carly's CLI command definitions.
 *
 * Single source of truth — the same `CommandDefinition`s that drive the CLI and
 * the MCP server also drive the n8n node. Run with:
 *
 *   npm run gen:n8n
 *
 * Output: ../n8n-nodes-carly/nodes/Carly/Carly.node.ts (a declarative
 * INodeType — no runtime dependencies, which is what n8n verification requires).
 *
 * Mapping (see docs/2026-06-23-1204-HANDOFF-n8n-node-scoping.md):
 *   group       -> n8n "resource"
 *   subcommand  -> n8n "operation"  (routing.request.method + url)
 *   field with fieldMappings 'path'  -> interpolated into the operation URL
 *   field with fieldMappings 'query' -> routing.send { type: 'query' }
 *   field with fieldMappings 'body'  -> routing.send { type: 'body'  }
 * Required fields become direct properties; optional fields go into an
 * "Additional Fields" collection so n8n only sends what the user fills in.
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

// Constant body values that the CLI injects in the handler rather than taking
// from user input (see src/commands/calendars/index.ts). These become fixed
// request body values on the operation in n8n.
const CONSTANT_BODY: Record<string, Record<string, unknown>> = {
  calendars_select: { selected: true },
  calendars_unselect: { selected: false },
};

// ---- Zod introspection helpers -------------------------------------------

function unwrap(schema: any): any {
  let s = schema;
  // Walk through wrappers that don't change the "shape" we care about.
  for (let i = 0; i < 10 && s?._def; i++) {
    const t = s._def.typeName;
    if (t === 'ZodOptional' || t === 'ZodNullable' || t === 'ZodDefault') {
      s = s._def.innerType;
    } else if (t === 'ZodEffects') {
      // z.preprocess(...) / .transform() — inner schema is on _def.schema.
      s = s._def.schema;
    } else {
      break;
    }
  }
  return s;
}

function n8nType(schema: any): 'string' | 'number' | 'boolean' | 'json' {
  const s = unwrap(schema);
  const t = s?._def?.typeName;
  if (t === 'ZodNumber') return 'number';
  if (t === 'ZodBoolean') return 'boolean';
  if (t === 'ZodArray' || t === 'ZodObject' || t === 'ZodRecord') return 'json';
  if (t === 'ZodUnion') {
    const opts: any[] = s._def.options ?? [];
    if (opts.some((o) => unwrap(o)?._def?.typeName === 'ZodBoolean')) return 'boolean';
    if (opts.every((o) => unwrap(o)?._def?.typeName === 'ZodNumber')) return 'number';
    return 'string';
  }
  return 'string';
}

function isOptional(schema: any): boolean {
  const t = schema?._def?.typeName;
  return t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodNullable';
}

function defaultFor(type: string): unknown {
  if (type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'json') return '';
  return '';
}

// ---- Display-name helpers -------------------------------------------------

function humanize(s: string): string {
  return (
    s
      .replace(/[_-]+/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      // n8n's lint insists on "ID", not "Id".
      .replace(/\bId\b/g, 'ID')
      .replace(/\bUid\b/g, 'UID')
      .replace(/\bUrl\b/g, 'URL')
  );
}

/**
 * Operation `action` strings, which n8n runs through `sentenceCase()` and then
 * compares. That strips apostrophes and parentheses, so anything punctuated
 * fails the check — command descriptions can't be reused verbatim. Same
 * phrasing as the Make app's module labels.
 */
const ACTION_LABELS: Record<string, string> = {
  whoami: 'Get profile',
  calendars_list: 'List calendars',
  calendars_select: 'Add a calendar to availability',
  calendars_unselect: 'Remove a calendar from availability',
  booking_pages_list: 'List booking pages',
  booking_pages_get: 'Get a booking page',
  booking_pages_create: 'Create a booking page',
  booking_pages_update: 'Update a booking page',
  booking_pages_delete: 'Delete a booking page',
  event_types_list: 'List event types',
  slots_list: 'List slots',
  bookings_list: 'List bookings',
  bookings_get: 'Get a booking',
};

/** Resource option names must be singular (node-param-resource-with-plural-option). */
const RESOURCE_LABELS: Record<string, string> = {
  profile: 'Profile',
  calendars: 'Calendar',
  'booking-pages': 'Booking Page',
  'event-types': 'Event Type',
  slots: 'Slot',
  bookings: 'Booking',
};

/**
 * n8n's description rules: encode angle brackets, say "ID" not "Id", start
 * boolean descriptions with "Whether", and — the fiddly one — a single-sentence
 * description must NOT end in a period while a multi-sentence one must. The
 * lint splits on ". " to decide which it is, so match that exactly.
 */
function cleanDescription(text: string, type: string, displayName: string): string | undefined {
  let out = text.trim();
  if (!out) return undefined;
  out = out.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  out = out.replace(/\bid\b/gi, 'ID').replace(/\buid\b/gi, 'UID');
  if (type === 'boolean' && !/^whether\b/i.test(out)) {
    // "Ask the guest for a phone number" -> "Whether to ask the guest ..."
    out = `Whether to ${out.charAt(0).toLowerCase()}${out.slice(1)}`;
  }
  // The lint drops the first literal "e.g." before counting, so an example
  // clause doesn't make a one-sentence description look like two.
  if (out.replace('e.g.', '').split('. ').length === 1) {
    out = out.replace(/\.+$/, '');
  } else if (!/[.!?]$/.test(out)) {
    out += '.';
  }
  // A description that just restates the label adds nothing, and n8n's lint
  // rejects it outright.
  if (out.replace(/\.$/, '').toLowerCase() === displayName.toLowerCase()) return undefined;
  return out;
}

/** Alphabetize option lists by the key n8n's unsorted-items rules check. */
function byName<T extends { name?: string; displayName?: string }>(items: T[], key: 'name' | 'displayName'): T[] {
  return [...items].sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')));
}

// ---- Field model ----------------------------------------------------------

interface FieldModel {
  field: string;
  location: 'path' | 'query' | 'body';
  type: 'string' | 'number' | 'boolean' | 'json';
  required: boolean;
  description: string;
}

/** Collect the user-facing fields for a command from its CLI mappings. */
function fieldsFor(cmd: CommandDefinition): FieldModel[] {
  const shape: Record<string, any> = (cmd.inputSchema as any).shape ?? {};
  const out: FieldModel[] = [];
  const seen = new Set<string>();

  const push = (field: string, description: string, requiredHint?: boolean) => {
    if (seen.has(field)) return;
    const location = cmd.fieldMappings[field];
    if (!location) return; // not sent on the wire
    seen.add(field);
    const z = shape[field];
    const type = n8nType(z);
    const required = requiredHint ?? !isOptional(z);
    out.push({ field, location, type, required, description });
  };

  for (const arg of cmd.cliMappings.args ?? []) {
    push(arg.field, humanize(arg.name), arg.required);
  }
  for (const opt of cmd.cliMappings.options ?? []) {
    push(opt.field, opt.description ?? humanize(opt.field));
  }
  return out;
}

// ---- Build the n8n description --------------------------------------------

const groupsInOrder: string[] = [];
const byGroup = new Map<string, CommandDefinition[]>();
for (const cmd of allCommands) {
  if (!byGroup.has(cmd.group)) {
    byGroup.set(cmd.group, []);
    groupsInOrder.push(cmd.group);
  }
  byGroup.get(cmd.group)!.push(cmd);
}

const properties: any[] = [];

// Resource selector.
properties.push({
  displayName: 'Resource',
  name: 'resource',
  type: 'options',
  noDataExpression: true,
  options: byName(
    groupsInOrder.map((g) => ({ name: RESOURCE_LABELS[g] ?? humanize(g), value: g })),
    'name',
  ),
  default: groupsInOrder[0],
});

// Per-resource: operation selector + operation-scoped fields.
for (const group of groupsInOrder) {
  const cmds = byGroup.get(group)!;

  properties.push({
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: [group] } },
    options: byName(
      cmds.map((cmd) => {
      // Build the request URL, interpolating any path params.
      let url = cmd.endpoint.path;
      for (const f of fieldsFor(cmd)) {
        if (f.location === 'path') {
          url = url.replace(`{${f.field}}`, `{{$parameter["${f.field}"]}}`);
        }
      }
      const isExpr = url.includes('{{');
      const request: any = { method: cmd.endpoint.method, url: isExpr ? `=${url}` : url };
      const constBody = CONSTANT_BODY[cmd.name];
      if (constBody) request.body = constBody;

      const name = humanize(cmd.subcommand);
      return {
        name,
        value: cmd.subcommand,
        action: ACTION_LABELS[cmd.name] ?? name,
        description: cleanDescription(cmd.description, 'string', name),
        routing: { request },
      };
    }),
    'name',
    ),
    default: cmds[0].subcommand,
  });

  // Fields, scoped to (resource, operation).
  for (const cmd of cmds) {
    const fields = fieldsFor(cmd);
    const show = { resource: [group], operation: [cmd.subcommand] };

    const required = fields.filter((f) => f.required);
    const optional = fields.filter((f) => !f.required);

    for (const f of required) {
      const displayName = humanize(f.field);
      const prop: any = {
        displayName,
        name: f.field,
        type: f.type,
        required: true,
        default: defaultFor(f.type),
        displayOptions: { show },
      };
      const desc = cleanDescription(f.description, f.type, displayName);
      if (desc) prop.description = desc;
      if (f.location !== 'path') {
        prop.routing = { send: { type: f.location, property: f.field } };
      }
      properties.push(prop);
    }

    if (optional.length) {
      properties.push({
        displayName: 'Additional Fields',
        name: 'additionalFields',
        type: 'collection',
        placeholder: 'Add Field',
        default: {},
        displayOptions: { show },
        options: byName(
          optional.map((f) => {
            const displayName = humanize(f.field);
            const opt: any = {
              displayName,
              name: f.field,
              type: f.type,
              default: defaultFor(f.type),
            };
            // n8n has hard-coded expectations for a parameter named "limit".
            if (f.field === 'limit') {
              opt.type = 'number';
              opt.typeOptions = { minValue: 1 };
              opt.default = 50;
              opt.description = 'Max number of results to return';
            } else {
              const desc = cleanDescription(f.description, f.type, displayName);
              if (desc) opt.description = desc;
            }
            if (f.location !== 'path') {
              opt.routing = { send: { type: f.location, property: f.field } };
            }
            return opt;
          }),
          'displayName',
        ),
      });
    }
  }
}

const description = {
  displayName: 'Carly',
  name: 'carly',
  icon: 'file:carly.png',
  group: ['transform'],
  version: 1,
  subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
  description: 'Read and manage Carly booking pages, event types, calendars, and bookings',
  defaults: { name: 'Carly' },
  // Lets the node be used as a tool by n8n's AI Agent — Carly is agent-native.
  usableAsTool: true,
  inputs: ['main'],
  outputs: ['main'],
  credentials: [{ name: 'carlyApi', required: true }],
  requestDefaults: {
    baseURL: '={{$credentials.baseUrl}}',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  },
  properties,
};

// ---- Emit -----------------------------------------------------------------

const banner = `// AUTO-GENERATED by carly-cli/scripts/gen-n8n-node.ts — DO NOT EDIT BY HAND.
// Regenerate with \`npm run gen:n8n\` from the carly-cli repo.
// Source of truth: carly-cli/src/commands/**.
`;

/**
 * JSON.stringify quotes every key. n8n's verification lint
 * (@n8n/eslint-plugin-community-nodes) walks the AST looking for identifier
 * keys, so `"icon"` and `"subtitle"` read as absent and the node is rejected
 * for missing properties it actually has. Unquote keys that are valid JS
 * identifiers; the line anchor keeps this off anything inside a string value.
 */
function serialize(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(
    /^(\s*)"([A-Za-z_$][A-Za-z0-9_$]*)":/gm,
    '$1$2:',
  );
}

const body = `import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

export class Carly implements INodeType {
  description: INodeTypeDescription = ${serialize(description)};
}
`;

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '../../n8n-nodes-carly/nodes/Carly/Carly.node.ts');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, banner + '\n' + body);

const toolCount = allCommands.length;
console.log(
  `Generated ${outPath}\n` +
    `  ${groupsInOrder.length} resources, ${toolCount} operations:\n` +
    groupsInOrder
      .map((g) => `    ${g}: ${byGroup.get(g)!.map((c) => c.subcommand).join(', ')}`)
      .join('\n'),
);
