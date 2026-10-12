import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { allCommands } from '../src/commands/index.js';
import { formsCreateCommand, formsUpdateCommand } from '../src/commands/forms/index.js';
import { bookingPagesUpdateCommand } from '../src/commands/booking-pages/index.js';
import { CarlyClient } from '../src/core/client.js';
import { createMcpServer } from '../src/mcp/server.js';

function recorder() {
  const calls: unknown[][] = [];
  const client = Object.fromEntries(['get', 'post', 'patch', 'put', 'delete', 'upload'].map((method) => [method, async (...args: unknown[]) => {
    calls.push([method, ...args]); return { ok: true };
  }])) as unknown as CarlyClient;
  return { client, calls };
}

test('form flags preserve false, null and stable field keys; omit untouched properties', async () => {
  const { client, calls } = recorder();
  const input = formsUpdateCommand.inputSchema.parse({ formId: '42', routes: 'null', appearance: 'null', notifyEmail: 'false', fields: '[{"key":"email","label":"Work email","type":"email"}]' });
  await formsUpdateCommand.handler(input, client);
  assert.deepEqual(calls, [['patch', '/forms/42', { fields: [{ key: 'email', label: 'Work email', type: 'email' }], routes: null, appearance: null, notify_email: false }]]);
});

test('form create takes JSON files and can redirect to a video page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'carly-forms-'));
  try {
    writeFileSync(join(dir, 'fields.json'), '[{"label":"Email","type":"email","required":true}]');
    const { client, calls } = recorder();
    const routes = { rules: [], fallback: { type: 'redirect', url: 'https://example.com/watch' } };
    const input = formsCreateCommand.inputSchema.parse({ name: 'Video', fields: `@${dir}/fields.json`, routes });
    await formsCreateCommand.handler(input, client);
    assert.deepEqual(calls[0], ['post', '/forms', { name: 'Video', fields: [{ label: 'Email', type: 'email', required: true }], routes }]);
  } finally { rmSync(dir, { recursive: true }); }
});

test('booking updates can clear settings and disable recurrence', async () => {
  const { client, calls } = recorder();
  const input = bookingPagesUpdateCommand.inputSchema.parse({ eventTypeId: 7, recurrenceFrequency: 'null', successRedirectUrl: null, scheduleId: 'null' });
  await bookingPagesUpdateCommand.handler(input, client);
  const body = calls[0][2] as Record<string, unknown>;
  assert.equal(body.recurrenceFrequency, null);
  assert.equal(body.successRedirectUrl, null);
  assert.equal(body.scheduleId, null);
});

test('private link, routing attribute and workflow commands send the documented HTTP shapes', async () => {
  const { client, calls } = recorder();
  const cases = [
    ['private_links_create', { eventTypeId: 8, data: '{"max_usage_count":1}' }],
    ['booking_attributes_assign', { orgId: 2, memberId: 3, attributeId: 4, data: { values: ['East'], weight: 100 } }],
    ['booking_connections_setup', { eventTypeId: 8, templateId: 'booking-email' }],
  ] as const;
  for (const [name, values] of cases) {
    const cmd = allCommands.find((item) => item.name === name)!;
    await cmd.handler(cmd.inputSchema.parse(values), client);
  }
  assert.deepEqual(calls, [
    ['post', '/booking-pages/8/private-links', { max_usage_count: 1 }],
    ['put', '/booking-pages/team/2/members/3/attributes/4', { values: ['East'], weight: 100 }],
    ['get', '/booking-pages/8/connections/setup', { template_id: 'booking-email' }],
  ]);
});

test('MCP advertises exactly the CLI command registry and executes forms through it', async () => {
  const { client: api, calls } = recorder();
  const server = createMcpServer(api);
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name).sort(), allCommands.map((cmd) => cmd.name).sort());
    assert.equal(new Set(tools.map((tool) => tool.name)).size, allCommands.length);
    assert.equal(tools.find((tool) => tool.name === 'forms_delete')?.annotations?.destructiveHint, true);
    assert.equal(tools.find((tool) => tool.name === 'forms_test_routing')?.annotations?.readOnlyHint, true);
    const result = await client.callTool({ name: 'forms_update', arguments: { formId: 42, routes: null, notifyEmail: false } });
    assert.ok(!result.isError);
    assert.deepEqual(calls[0], ['patch', '/forms/42', { routes: null, notify_email: false }]);
    const invalid = await client.callTool({ name: 'forms_update', arguments: { formId: -1 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 1);
  } finally { await client.close(); await server.close(); }
});

test('MCP propagates API errors instead of reporting a successful tool result', async () => {
  const { client: api } = recorder();
  api.get = async () => { throw new Error('Insufficient scope'); };
  const server = createMcpServer(api);
  const client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try {
    const result = await client.callTool({ name: 'forms_list', arguments: {} });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /Insufficient scope/);
  } finally { await client.close(); await server.close(); }
});

test('writes are never retried after server failures; request has scoped credentials', async () => {
  let count = 0;
  const server = createServer((req, res) => {
    count++;
    assert.equal(req.url, '/api/v1/forms');
    assert.equal(req.headers.authorization, 'Bearer test-only-key');
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Try later' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const api = new CarlyClient({ apiKey: 'test-only-key', baseUrl: `http://127.0.0.1:${address.port}` });
    await assert.rejects(api.post('/forms', { name: 'Example' }), /Try later/);
    assert.equal(count, 1);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test('shell form fields reach the API without colliding with output filtering; logos use multipart', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const seen: Array<{ path: string; contentType: string; body: string }> = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    seen.push({ path: req.url!, contentType: req.headers['content-type']!, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ form: { id: 42, name: 'Video' }, logo_key: 'test-logo' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = mkdtempSync(join(tmpdir(), 'carly-shell-'));
  try {
    const { port } = server.address() as { port: number };
    const args = ['--import', 'tsx', 'src/index.ts', '--api-key', 'test-only-key', '--api-base-url', `http://127.0.0.1:${port}`];
    const fields = '[{"key":"email","label":"Email","type":"email"}]';
    const created = await run(process.execPath, [...args, 'forms', 'create', '--name', 'Video', '--form-fields', fields]);
    assert.equal(JSON.parse(created.stdout).form.id, 42);
    assert.deepEqual(JSON.parse(seen[0].body).fields, JSON.parse(fields));
    const legacyFilter = await run(process.execPath, ['--import', 'tsx', 'src/index.ts', 'forms', 'list', '--api-key', 'test-only-key', '--api-base-url', `http://127.0.0.1:${port}`, '--fields', 'form']);
    assert.deepEqual(JSON.parse(legacyFilter.stdout), { form: { id: 42, name: 'Video' } });
    const filtered = await run(process.execPath, [...args, 'forms', 'update', '42', '--form-fields', fields, '--fields', 'form']);
    assert.deepEqual(JSON.parse(filtered.stdout), { form: { id: 42, name: 'Video' } });
    writeFileSync(join(dir, 'logo.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
    await run(process.execPath, [...args, 'booking-branding', 'upload-logo', '--content-base64', `@${dir}/logo.png`, '--mime-type', 'image/png', '--org', '2']);
    assert.equal(seen[3].path, '/api/v1/booking-pages/branding/logo?org=2');
    assert.match(seen[3].contentType, /multipart\/form-data; boundary=/);
    assert.match(seen[3].body, /name="file"; filename="logo"/);
    assert.match(seen[3].body, /Content-Type: image\/png/);
  } finally {
    rmSync(dir, { recursive: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('carly mcp starts over stdio and honors CLI credential and base URL flags', async () => {
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/v1/forms');
    assert.equal(req.headers.authorization, 'Bearer test-stdio-key');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([{ id: 42, name: 'Video' }]));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/index.ts', '--api-key', 'test-stdio-key', '--api-base-url', `http://127.0.0.1:${port}`, 'mcp'],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stdio-test', version: '1' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'forms_list', arguments: {} });
    assert.ok(!result.isError);
    assert.match(JSON.stringify(result.content), /Video/);
    assert.equal((await client.listTools()).tools.length, allCommands.length);
  } finally {
    await client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
