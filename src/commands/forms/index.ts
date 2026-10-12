import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { imageBase64, imageMimeType } from '../../core/image-input.js';
import type { CommandDefinition, CliOptionMapping } from '../../core/types.js';
import type { CarlyClient } from '../../core/client.js';

/** CLI accepts JSON or @file; MCP clients pass native objects/arrays. */
export function jsonInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value.startsWith('@') ? readFileSync(value.slice(1), 'utf8') : value); }
  catch { return value; } // The schema gives a useful shape error.
}

const bool = z.preprocess((v) => v === 'true' ? true : v === 'false' ? false : v, z.boolean());
const object = z.preprocess(jsonInput, z.record(z.unknown()).nullable());
const field = z.object({
  key: z.string().optional(), label: z.string().min(1).max(200),
  type: z.enum(['text', 'textarea', 'email', 'phone', 'number', 'select', 'radio', 'checkboxes', 'date', 'consent']).optional(),
  required: z.boolean().optional(), hidden: z.boolean().optional(), placeholder: z.string().optional(),
  options: z.array(z.string()).optional(), crm_field: z.string().optional(),
  kind: z.string().optional(), checked: z.boolean().optional(),
});
const fields = z.preprocess(jsonInput, z.array(field).max(30));
const formId = z.coerce.number().int().positive();
const options: CliOptionMapping[] = [
  { flags: '--name <text>', field: 'name', description: 'Form name' },
  { flags: '--form-fields <json>', field: 'fields', description: 'Fields array or @file; preserves supplied field keys' },
  { flags: '--intro-text <text>', field: 'introText', description: 'Introductory text' },
  { flags: '--submit-label <text>', field: 'submitLabel', description: 'Submit button text' },
  { flags: '--success-message <text>', field: 'successMessage', description: 'Default thank-you message' },
  { flags: '--routes <json>', field: 'routes', description: 'Ordered rules and fallback, or null to clear; JSON or @file' },
  { flags: '--legal <json>', field: 'legal', description: 'Consent fine print; JSON or @file, null clears it' },
  { flags: '--appearance <json>', field: 'appearance', description: 'Appearance and logo_key; JSON or @file, null resets it' },
  { flags: '--notify-email <true|false>', field: 'notifyEmail', description: 'Email the owner each submission' },
  { flags: '--webhook-url <url>', field: 'webhookUrl', description: 'Submission webhook; empty string removes it' },
  { flags: '--status <active|paused|archived>', field: 'status', description: 'Whether the form accepts submissions' },
];
const editable = {
  name: z.string().min(1).max(255).optional(), fields: fields.optional(),
  introText: z.string().optional(), submitLabel: z.string().optional(), successMessage: z.string().optional(),
  routes: object.optional(), legal: object.optional(), appearance: object.optional(),
  notifyEmail: bool.optional(), webhookUrl: z.string().optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
};
const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

function formCommand(config: Omit<CommandDefinition, 'group' | 'handler'>): CommandDefinition {
  return {
    ...config, group: 'forms',
    handler: async (input: Record<string, unknown>, client: CarlyClient) => {
      let path = config.endpoint.path;
      const body: Record<string, unknown> = {};
      const query: Record<string, unknown> = {};
      for (const [key, where] of Object.entries(config.fieldMappings)) {
        if (input[key] === undefined) continue;
        if (where === 'path') path = path.replace(`{${key}}`, encodeURIComponent(String(input[key])));
        else (where === 'body' ? body : query)[snake(key)] = input[key];
      }
      if (config.endpoint.method === 'GET') return client.get(path, query);
      if (config.endpoint.method === 'DELETE') return client.delete(path, query);
      if (config.endpoint.method === 'PATCH') return client.patch(path, body);
      return client.post(path, body);
    },
  };
}
const bodyFields = Object.fromEntries(Object.keys(editable).map((key) => [key, 'body' as const]));
const idArg = { name: 'form-id', field: 'formId', required: true };

export const formsCreateCommand = formCommand({
  name: 'forms_create', subcommand: 'create', scope: 'forms:write',
  description: 'Create a hosted form with fields, routing, consent, appearance and notifications. Returns its public URL and embed snippet. Redirect example: {"rules":[],"fallback":{"type":"redirect","url":"https://example.com/watch"}}.',
  examples: [`carly forms create --name "Watch the video" --form-fields '[{"key":"email","label":"Email","type":"email","required":true}]' --routes '{"rules":[],"fallback":{"type":"redirect","url":"https://example.com/watch"}}'`],
  inputSchema: z.object({ ...editable, name: z.string().min(1).max(255) }),
  cliMappings: { options }, endpoint: { method: 'POST', path: '/forms' }, fieldMappings: bodyFields,
});
export const formsUpdateCommand = formCommand({
  name: 'forms_update', subcommand: 'update', scope: 'forms:write',
  description: 'Edit an owned form. Only supplied properties change. Nested fields replace previous values; null clears routes, legal or appearance. Removing workflow-bound fields requires explicit force.',
  inputSchema: z.object({ formId, ...editable, force: bool.optional() }),
  cliMappings: { args: [idArg], options: [...options, { flags: '--force', field: 'force', description: 'Allow removal of fields used by workflows' }] },
  endpoint: { method: 'PATCH', path: '/forms/{formId}' }, fieldMappings: { formId: 'path', ...bodyFields, force: 'body' },
});
export const formsCommands: CommandDefinition[] = [
  formCommand({ name: 'forms_list', subcommand: 'list', scope: 'forms:read', description: 'List owned and shared read-only forms with their public links, fields and routing.', inputSchema: z.object({}), cliMappings: {}, endpoint: { method: 'GET', path: '/forms' }, fieldMappings: {} }),
  formCommand({ name: 'forms_get', subcommand: 'get', scope: 'forms:read', description: 'Read an owned form, including fields, routes, appearance, notifications, webhook and embed snippet.', inputSchema: z.object({ formId }), cliMappings: { args: [idArg] }, endpoint: { method: 'GET', path: '/forms/{formId}' }, fieldMappings: { formId: 'path' } }),
  formsCreateCommand, formsUpdateCommand,
  formCommand({ name: 'forms_delete', subcommand: 'delete', scope: 'forms:write', description: 'Permanently delete a form and its submissions. Force pauses dependent workflows before deletion.', inputSchema: z.object({ formId, force: bool.optional() }), cliMappings: { args: [idArg], options: [{ flags: '--force', field: 'force', description: 'Pause dependent workflows and delete' }] }, endpoint: { method: 'DELETE', path: '/forms/{formId}' }, fieldMappings: { formId: 'path', force: 'query' } }),
  formCommand({ name: 'forms_submissions', subcommand: 'submissions', scope: 'forms:read', description: 'Read an owned form’s responses, newest first, with field labels and total count.', inputSchema: z.object({ formId, limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }), cliMappings: { args: [idArg], options: [{ flags: '--limit <n>', field: 'limit' }, { flags: '--offset <n>', field: 'offset' }] }, endpoint: { method: 'GET', path: '/forms/{formId}/submissions' }, fieldMappings: { formId: 'path', limit: 'query', offset: 'query' } }),
  ...[
    ['routing-targets', 'List booking pages and team attributes available for form routing.'],
    ['crm-fields', 'List People fields form answers can save to.'],
    ['phone-regions', 'List supported phone regions and the default country.'],
  ].map(([name, description]) => formCommand({ name: `forms_${name.replaceAll('-', '_')}`, subcommand: name, scope: 'forms:read', description, inputSchema: z.object({}), cliMappings: {}, endpoint: { method: 'GET', path: `/forms/${name}` }, fieldMappings: {} })),
  formCommand({ name: 'forms_test_routing', subcommand: 'test-routing', scope: 'forms:read', description: 'Test draft fields/routing against example answers without saving or submitting a response.', inputSchema: z.object({ fields: fields.optional(), routes: object.optional(), answers: z.preprocess(jsonInput, z.record(z.unknown())).optional() }), cliMappings: { options: [{ flags: '--form-fields <json>', field: 'fields' }, { flags: '--routes <json>', field: 'routes' }, { flags: '--answers <json>', field: 'answers' }] }, endpoint: { method: 'POST', path: '/forms/route-test' }, fieldMappings: { fields: 'body', routes: 'body', answers: 'body' }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }),
  formCommand({ name: 'forms_upload_logo', subcommand: 'upload-logo', scope: 'forms:write', description: 'Upload base64 image bytes (PNG/JPEG/GIF/WebP, up to 512 KB). Save the returned logo_key in appearance.logo_key.', inputSchema: z.object({ contentBase64: imageBase64, mimeType: imageMimeType }), cliMappings: { options: [{ flags: '--content-base64 <base64-or-@file>', field: 'contentBase64' }, { flags: '--mime-type <type>', field: 'mimeType' }] }, endpoint: { method: 'POST', path: '/forms/logo' }, fieldMappings: { contentBase64: 'body', mimeType: 'body' } }),
];
