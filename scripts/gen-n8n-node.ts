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
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
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
  options: groupsInOrder.map((g) => ({ name: humanize(g), value: g })),
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
    options: cmds.map((cmd) => {
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

      return {
        name: humanize(cmd.subcommand),
        value: cmd.subcommand,
        action: cmd.description.split('.')[0],
        description: cmd.description,
        routing: { request },
      };
    }),
    default: cmds[0].subcommand,
  });

  // Fields, scoped to (resource, operation).
  for (const cmd of cmds) {
    const fields = fieldsFor(cmd);
    const show = { resource: [group], operation: [cmd.subcommand] };

    const required = fields.filter((f) => f.required);
    const optional = fields.filter((f) => !f.required);

    for (const f of required) {
      const prop: any = {
        displayName: humanize(f.field),
        name: f.field,
        type: f.type,
        required: true,
        default: defaultFor(f.type),
        description: f.description,
        displayOptions: { show },
      };
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
        options: optional.map((f) => {
          const opt: any = {
            displayName: humanize(f.field),
            name: f.field,
            type: f.type,
            default: defaultFor(f.type),
            description: f.description,
          };
          if (f.location !== 'path') {
            opt.routing = { send: { type: f.location, property: f.field } };
          }
          return opt;
        }),
      });
    }
  }
}

const description = {
  displayName: 'Carly',
  name: 'carly',
  icon: 'file:carly.svg',
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

const body = `import type { INodeType, INodeTypeDescription } from 'n8n-workflow';

export class Carly implements INodeType {
  description: INodeTypeDescription = ${JSON.stringify(description, null, 2)};
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
