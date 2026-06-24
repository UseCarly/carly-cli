/**
 * Codegen: emit Pipedream component files from Carly's command definitions.
 *
 *   npm run gen:pipedream   ->   ../carly-pipedream/  (mirrors components/carly/)
 *
 * Same single source of truth as the CLI, MCP, n8n, Zapier, Make, and OpenAPI.
 * NOTE: Pipedream must register the `carly` app slug + API-key connect form on
 * their side before these work (file the "Request Apps" issue). These files are
 * PR-ready for PipedreamHQ/pipedream once the slug exists.
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
function isJson(s: any): boolean {
  const t = unwrap(s)?._def?.typeName;
  return t === 'ZodArray' || t === 'ZodObject' || t === 'ZodRecord';
}
function isOptional(s: any): boolean {
  const t = s?._def?.typeName;
  return t === 'ZodOptional' || t === 'ZodDefault' || t === 'ZodNullable';
}
function pdType(s: any): string {
  const t = unwrap(s)?._def?.typeName;
  if (t === 'ZodNumber') return 'integer';
  if (t === 'ZodBoolean') return 'boolean';
  if (t === 'ZodUnion') {
    const opts: any[] = unwrap(s)?._def?.options ?? [];
    if (opts.some((o) => unwrap(o)?._def?.typeName === 'ZodBoolean')) return 'boolean';
  }
  if (isJson(s)) return 'object';
  return 'string';
}
function humanize(s: string): string {
  return s.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

interface FieldModel { field: string; location: 'path' | 'query' | 'body'; type: string; required: boolean; help: string; }
function fieldsFor(cmd: CommandDefinition): FieldModel[] {
  const shape: Record<string, any> = (cmd.inputSchema as any).shape ?? {};
  const out: FieldModel[] = []; const seen = new Set<string>();
  const push = (field: string, help: string, requiredHint?: boolean) => {
    const location = cmd.fieldMappings[field];
    if (!location || seen.has(field)) return;
    seen.add(field);
    const z = shape[field];
    out.push({ field, location, type: pdType(z), required: requiredHint ?? !isOptional(z), help });
  };
  for (const arg of cmd.cliMappings.args ?? []) push(arg.field, humanize(arg.name), arg.required);
  for (const opt of cmd.cliMappings.options ?? []) push(opt.field, opt.description ?? humanize(opt.field));
  return out;
}

const js = (s: string) => JSON.stringify(s);

// ---- Emit ------------------------------------------------------------------
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '../../carly-pipedream');
mkdirSync(outDir, { recursive: true });
const write = (rel: string, content: string) => {
  const p = resolve(outDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
};

// app file
write(
  'carly.app.mjs',
  `import { axios } from "@pipedream/platform";

export default {
  type: "app",
  app: "carly",
  propDefinitions: {},
  methods: {
    _baseUrl() {
      return ${js(BASE_URL)};
    },
    _makeRequest({ $ = this, path, ...opts }) {
      return axios($, {
        url: \`\${this._baseUrl()}\${path}\`,
        headers: {
          Authorization: \`Bearer \${this.$auth.api_key}\`,
          Accept: "application/json",
        },
        ...opts,
      });
    },
  },
};
`,
);

write(
  'package.json',
  JSON.stringify(
    {
      name: '@pipedream/carly',
      version: '0.0.1',
      description: 'Pipedream Carly Components',
      main: 'carly.app.mjs',
      keywords: ['pipedream', 'carly'],
      homepage: 'https://pipedream.com/apps/carly',
      author: 'Pipedream <support@pipedream.com> (https://pipedream.com/)',
      publishConfig: { access: 'public' },
      dependencies: { '@pipedream/platform': '^3.0.0' },
    },
    null,
    2,
  ) + '\n',
);

const actions: string[] = [];
for (const cmd of allCommands) {
  const slug = cmd.name.replace(/_/g, '-');
  const method = cmd.endpoint.method.toUpperCase();
  const fields = fieldsFor(cmd);

  // props
  const propLines = fields.map((f) => {
    const parts = [
      `      type: ${js(f.type)}`,
      `      label: ${js(humanize(f.field))}`,
      `      description: ${js(f.help || humanize(f.field))}`,
    ];
    if (!f.required) parts.push('      optional: true');
    return `    ${f.field}: {\n${parts.join(',\n')},\n    },`;
  });

  // request pieces
  let pathExpr = cmd.endpoint.path;
  for (const f of fields) if (f.location === 'path') pathExpr = pathExpr.replace(`{${f.field}}`, '${this.' + f.field + '}');
  const pathStr = pathExpr.includes('${') ? '`' + pathExpr + '`' : js(pathExpr);

  const q = fields.filter((f) => f.location === 'query').map((f) => `        ${f.field}: this.${f.field},`);
  const b = fields.filter((f) => f.location === 'body').map((f) => `        ${f.field}: this.${f.field},`);
  for (const [k, v] of Object.entries(CONSTANT_BODY[cmd.name] ?? {})) b.push(`        ${k}: ${JSON.stringify(v)},`);

  const reqLines = [`        $`, `        method: ${js(method)}`, `        path: ${pathStr}`];
  if (q.length) reqLines.push(`        params: {\n${q.join('\n')}\n        }`);
  if (b.length) reqLines.push(`        data: {\n${b.join('\n')}\n        }`);

  const action = `import carly from "../../carly.app.mjs";

export default {
  key: ${js('carly-' + slug)},
  name: ${js(humanize(cmd.subcommand) + ' ' + humanize(cmd.group))},
  description: ${js(cmd.description + ' [See the docs](https://www.usecarly.com/developers).')},
  version: "0.0.1",
  type: "action",
  annotations: {
    readOnlyHint: ${method === 'GET'},
    destructiveHint: ${method === 'DELETE'},
    openWorldHint: true,
  },
  props: {
    carly,
${propLines.join('\n')}
  },
  async run({ $ }) {
    const response = await this.carly._makeRequest({
${reqLines.join(',\n')},
    });
    $.export("$summary", ${js(humanize(cmd.subcommand) + ' ' + humanize(cmd.group) + ' succeeded')});
    return response;
  },
};
`;
  write(`actions/${slug}/${slug}.mjs`, action);
  actions.push(slug);
}

console.log(
  `Generated ${outDir}\n  carly.app.mjs, package.json, ${actions.length} actions:\n    ${actions.join(', ')}`,
);
