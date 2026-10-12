import { z } from 'zod';
import type { CommandDefinition } from '../../core/types.js';
import { jsonInput } from '../forms/index.js';
import { imageBase64, imageMimeType } from '../../core/image-input.js';

const id = z.coerce.number().int().positive();
const data = z.preprocess(jsonInput, z.record(z.unknown()));
const page = '/booking-pages/{eventTypeId}';
const team = '/booking-pages/team/{orgId}';

/** Controls reuse the editor's validation. --data takes the documented JSON body. */
function control(group: string, subcommand: string, method: string, path: string,
  description: string, shape: z.ZodRawShape = {}, scope?: string, readOnly = method === 'GET'): CommandDefinition {
  const pathKeys = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const queryKeys = Object.keys(shape).filter((key) => key !== 'data' && !pathKeys.includes(key));
  const kebab = (key: string) => key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  const snake = (key: string) => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return {
    name: `${group}_${subcommand}`.replaceAll('-', '_'), group, subcommand, description,
    scope: scope ?? (readOnly ? 'booking_pages:read' : 'booking_pages:write'),
    inputSchema: z.object({ ...Object.fromEntries(pathKeys.map((key) => [key, id])), ...shape }),
    cliMappings: {
      args: pathKeys.map((field) => ({ name: kebab(field), field, required: true })),
      options: Object.keys(shape).filter((key) => !pathKeys.includes(key)).map((field) => ({
        field, flags: `--${kebab(field)} <${field === 'data' ? 'json' : 'value'}>`,
        description: field === 'data' ? 'Request body as JSON or @file; see command description' : undefined,
      })),
    },
    endpoint: { method, path },
    fieldMappings: { ...Object.fromEntries(pathKeys.map((key) => [key, 'path' as const])), ...Object.fromEntries(queryKeys.map((key) => [key, 'query' as const])), ...(shape.data ? { data: 'body' as const } : {}) },
    annotations: { readOnlyHint: readOnly, destructiveHint: ['DELETE', 'PATCH', 'PUT'].includes(method), openWorldHint: true },
    handler: async (input, client) => {
      let url = path;
      for (const key of pathKeys) url = url.replace(`{${key}}`, encodeURIComponent(String(input[key])));
      const query = Object.fromEntries(queryKeys.filter((key) => input[key] !== undefined).map((key) => [snake(key), input[key]]));
      if (method === 'GET') return client.get(url, query);
      if (method === 'DELETE') return client.delete(url, query);
      const qs = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)] as [string, string]));
      if (qs.size) url += `?${qs}`;
      if (method === 'PATCH') return client.patch(url, input.data);
      if (method === 'PUT') return client.put(url, input.data);
      return client.post(url, input.data);
    },
  };
}

export const bookingControlCommands: CommandDefinition[] = [
  control('booking-branding', 'set-removal', 'PATCH', `${team}/branding-removal`, 'Set team booking branding removal. Data: {"hide_carly_branding":true}. Requires the team branding permission.', { data }),
  {
    name: 'booking_branding_upload_logo', group: 'booking-branding', subcommand: 'upload-logo',
    description: 'Upload a profile logo (PNG/JPEG/GIF/WebP, up to 512 KB). Pass base64 image bytes or @image-file. Optional org selects a team profile.',
    scope: 'booking_pages:write',
    inputSchema: z.object({ contentBase64: imageBase64, mimeType: imageMimeType, org: id.optional() }),
    cliMappings: { options: [{ flags: '--content-base64 <base64-or-@file>', field: 'contentBase64' }, { flags: '--mime-type <type>', field: 'mimeType' }, { flags: '--org <id>', field: 'org' }] },
    endpoint: { method: 'POST', path: '/booking-pages/branding/logo' },
    fieldMappings: { contentBase64: 'body', mimeType: 'body', org: 'query' },
    handler: (input, client) => client.upload(`/booking-pages/branding/logo${input.org ? `?org=${input.org}` : ''}`, Buffer.from(input.contentBase64, 'base64'), input.mimeType),
  },
  control('private-links', 'list', 'GET', `${page}/private-links`, 'List recoverable private booking links, expiry, usage limits and revocation state. Returned URLs are credentials.'),
  control('private-links', 'create', 'POST', `${page}/private-links`, 'Create a private booking link. Optional data: {"max_usage_count":1,"expires_at":"2027-01-01T00:00:00Z"}. Returns a bearer URL.', { data: data.optional() }),
  control('private-links', 'revoke', 'DELETE', `${page}/private-links/{linkId}`, 'Revoke a private link. If it was the last usable link on a gated page, returns its replacement URL.'),
  control('booking-reminders', 'preview', 'POST', `${page}/reminder-preview`, 'Render an unsaved reminder. Data uses a reminder config: subject, body_text, body_html, widgets, trigger (on_booking/before_event/after_event), offset_minutes. Sends nothing.', { data }, undefined, true),
  control('booking-reminders', 'test', 'POST', `${page}/reminder-test`, 'Send a draft reminder to your own email address. Data is a reminder config as in preview. Requires reminder entitlement; limited to 3 tests/minute and 20/hour.', { data }),
  control('booking-reminders', 'insights', 'GET', `${page}/reminder-insights`, 'Read reminder delivery and engagement metrics. Team pages require insights permission.'),
  control('booking-connections', 'list', 'GET', `${page}/connections`, 'List connected workflows and available booking integrations.'),
  control('booking-connections', 'setup', 'GET', `${page}/connections/setup`, 'Read setup fields for a booking workflow template.', { templateId: z.string().min(1) }),
  control('booking-connections', 'create', 'POST', `${page}/connections`, 'Create a booking workflow connection. Data: {template_id, inputs?, events?, params?, labels?}. Requires booking_pages:write and workflows:write.', { data }, 'workflows:write'),
  control('booking-branding', 'get', 'GET', '/booking-pages/branding', 'Read profile branding. Optional org selects an authorized team; otherwise uses your personal profile.', { org: id.optional() }),
  control('booking-branding', 'update', 'POST', '/booking-pages/branding', 'Update profile branding. Data accepts display_name, page_name, bio, brand_color and widgets. Optional org selects a team.', { org: id.optional(), data }),
  control('booking-branding', 'delete-logo', 'DELETE', '/booking-pages/branding/logo', 'Remove a personal or team profile logo.', { org: id.optional() }),
  control('schedules', 'duplicate', 'POST', '/schedules/{scheduleId}/duplicate', 'Copy a working-hours schedule and its date overrides. Optional data: {"name":"New schedule"}.', { data: data.optional() }),
  control('booking-attributes', 'list', 'GET', `${team}/attributes`, 'List team routing attributes. Assignments are included only with management permission.'),
  control('booking-attributes', 'create', 'POST', `${team}/attributes`, 'Create a team routing attribute. Data: {name, type, slug?, enabled?, options?}. Uses the team settings permissions and validator.', { data }),
  control('booking-attributes', 'update', 'PATCH', `${team}/attributes/{attributeId}`, 'Update a routing attribute. Data: {name?, enabled?}.', { data }),
  control('booking-attributes', 'delete', 'DELETE', `${team}/attributes/{attributeId}`, 'Delete a routing attribute and its member assignments.'),
  control('booking-attributes', 'assign', 'PUT', `${team}/members/{memberId}/attributes/{attributeId}`, 'Replace a member’s routing attribute values. Data: {"values":[...],"weight":100}. Select values are option IDs; scalar values are text/numbers. memberId is the organization membership id.', { data }),
  control('booking-import', 'preview', 'POST', '/booking-pages/import/calendly/preview', 'Preview available Calendly event types and schedules. Data: {"token":"Calendly personal access token"}. The token is used for this request only.', { data }, undefined, true),
  control('booking-import', 'calendly', 'POST', '/booking-pages/import/calendly', 'Import selected Calendly event types. Data: {token, event_type_uris:[...], schedule_uri?}. Use preview to choose them. Requires a personal Carly key.', { data }),
];
