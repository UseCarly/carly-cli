/**
 * Push the generated Make app to the live app builder via Make's SDK API.
 *
 *   npm run gen:make && npm run push:make
 *   npm run push:make -- --dry-run     # show what would change, touch nothing
 *
 * Make's builder is the only UI for custom apps, and pasting fourteen modules
 * by hand across five tabs each is both slow and easy to get subtly wrong.
 * This pushes the same files `gen-make-app.ts` emits, then reads each one back
 * to confirm it landed.
 *
 * Auth: MAKE_TOKEN, or a token in ~/.make-token. Needs sdk-apps:read and
 * sdk-apps:write. The token is never logged.
 *
 * Not handled here — Make fixes a module's type at creation, so turning the
 * two Search-typed get-by-ID modules into Actions still has to happen in the
 * builder. This script reports them rather than pretending otherwise.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const DRY_RUN = process.argv.includes('--dry-run');
const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '../../carly-make');

const readJson = (rel) => JSON.parse(readFileSync(resolve(appDir, rel), 'utf8'));

function loadToken() {
  if (process.env.MAKE_TOKEN) return process.env.MAKE_TOKEN.trim();
  try {
    return readFileSync(resolve(homedir(), '.make-token'), 'utf8').trim();
  } catch {
    console.error('No token. Set MAKE_TOKEN or write one to ~/.make-token.');
    process.exit(1);
  }
}

const manifest = readJson('make-manifest.json');
const TOKEN = loadToken();
const BASE = `https://${manifest.zone}.make.com/api/v2/sdk/apps/${manifest.app}/${manifest.version}`;

let failures = 0;

async function call(method, path, body, contentType = 'application/jsonc') {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Token ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': contentType }),
    },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

/** PUT a section, then GET it back and compare. */
async function putSection(modName, section, value) {
  const label = `${modName}/${section}`;
  if (DRY_RUN) {
    console.log(`  would PUT ${label}`);
    return;
  }
  await call('PUT', `/modules/${modName}/${section}`, value);
  const after = await call('GET', `/modules/${modName}/${section}`);
  const same = JSON.stringify(after) === JSON.stringify(value);
  console.log(`  ${same ? '✓' : '✗'} ${label}`);
  if (!same) failures++;
}

async function pushModule(entry) {
  const mod = readJson(entry.file);
  console.log(`\n${entry.name}  (${entry.label})`);

  await putSection(entry.name, 'api', mod.communication);
  await putSection(entry.name, 'expect', mod.mappableParameters ?? []);
  await putSection(entry.name, 'interface', mod.interface ?? []);

  const meta = { label: entry.label, description: entry.description };
  if (entry.crud) meta.crud = entry.crud;
  if (DRY_RUN) {
    console.log(`  would PATCH metadata ${JSON.stringify(meta)}`);
    return;
  }
  // PATCH echoes the pre-update record, and a GET straight afterwards can
  // still serve the old one — the module record is read-after-write lagged in
  // a way the section endpoints aren't. Retry before calling it a failure.
  await call('PATCH', `/modules/${entry.name}`, meta, 'application/json');
  let appModule;
  let ok = false;
  for (let attempt = 0; attempt < 5 && !ok; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    ({ appModule } = await call('GET', `/modules/${entry.name}`));
    ok =
      appModule.label === entry.label &&
      appModule.description === entry.description &&
      (!entry.crud || appModule.crud === entry.crud);
  }
  console.log(`  ${ok ? '✓' : '✗'} ${entry.name}/metadata`);
  if (!ok) failures++;

  const liveType = appModule.typeId === 9 ? 'search' : appModule.typeId === 4 ? 'action' : 'other';
  if (entry.wantsType === 'action' && liveType === 'search') {
    console.log(`  ! ${entry.name} is a Search module but should be an Action — recreate it in the builder`);
  }
}

async function main() {
  console.log(`${DRY_RUN ? '[dry run] ' : ''}${manifest.app} v${manifest.version} on ${manifest.zone}`);

  // App-level sections.
  for (const [section, file] of [
    ['base', 'base.imljson'],
    ['groups', 'groups.json'],
  ]) {
    if (DRY_RUN) {
      console.log(`would PUT ${section}`);
      continue;
    }
    await call('PUT', `/${section}`, readJson(file));
    const after = await call('GET', `/${section}`);
    const same = JSON.stringify(after) === JSON.stringify(readJson(file));
    console.log(`${same ? '✓' : '✗'} ${section}`);
    if (!same) failures++;
  }

  for (const entry of manifest.modules) await pushModule(entry);

  console.log(
    failures === 0
      ? '\nAll sections pushed and verified.'
      : `\n${failures} section(s) did not match after write — re-check those in the builder.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
