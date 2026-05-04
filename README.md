# carly-cli

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Agent-native CLI and MCP server for [Carly](https://www.usecarly.com) — the AI scheduling assistant. Read and manage booking pages, event types, calendars, and bookings from your shell or any MCP-compatible client.

11 tools across 5 resource groups. Same command definitions drive the CLI and the MCP server, so there is no drift between human and agent interfaces.

## Install

```bash
npm install -g carly-ai
```

Or run from source:

```bash
git clone https://github.com/usecarly/carly-cli.git
cd carly-cli
npm install && npm run build
npm link       # exposes `carly` on PATH
```

## Quick start

**Brand new user?** Sign up from the CLI — it opens the OAuth consent page in your browser, connects your calendar, and you land back in the dashboard. Then mint an API key and run `carly login`.

```bash
carly signup                  # opens Google OAuth (use --with microsoft for Outlook)
# ... approve in browser, then:
carly login                   # paste the API key you minted at /booking-pages (expand "Generate API key")
```

**Already have a Carly account?**

```bash
# 1. Authenticate (interactive — saves to ~/.carly-cli/config.json)
carly login

# 2. Confirm the key works
carly profile whoami --pretty

# 3. See what you have
carly calendars list --output table
carly booking-pages list --output table
carly bookings list --output table
```

### Connect additional calendars / video providers

```bash
carly calendars connect google       # Google Calendar (also handles first-time signup)
carly calendars connect microsoft    # Outlook calendar + Teams meetings
carly calendars connect zoom         # Zoom (for video-only; requires existing Carly account)
```

Each command opens the dashboard's OAuth page in your browser. No tokens touch the CLI.

## Authentication

Resolved in priority order:

| # | Method | Example |
|---|--------|---------|
| 1 | `--api-key` flag | `carly --api-key carly_live_xxxx profile whoami` |
| 2 | `CARLY_API_KEY` env var | `export CARLY_API_KEY=carly_live_xxxx` |
| 3 | Config file | `carly login` writes `~/.carly-cli/config.json` (mode `0600`) |

Base URL defaults to `https://dashboard.carlyassistant.com` and can be overridden with `--api-base-url` or `CARLY_API_BASE_URL`.

Mint a key at `<base-url>/booking-pages` → expand **Generate API key** (under "Use Carly from your terminal or AI agent"). Scopes are enforced server-side; see [Scopes](#scopes) below.

## MCP server setup

`carly mcp` starts an MCP server over stdio that exposes every CLI command as a tool to any MCP-compatible client.

### Claude Code

```bash
claude mcp add carly -- carly mcp
# or, before `npm link`:
claude mcp add carly -- node /path/to/carly-cli/dist/mcp.js
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "carly": {
      "command": "carly",
      "args": ["mcp"],
      "env": {
        "CARLY_API_KEY": "carly_live_xxxx"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "carly": {
      "command": "carly",
      "args": ["mcp"],
      "env": {
        "CARLY_API_KEY": "carly_live_xxxx"
      }
    }
  }
}
```

## Command reference

### Auth + utility

```bash
carly login                     # Interactive API key setup
carly logout                    # Remove stored credentials
carly auth-status               # Show current auth resolution
carly mcp                       # Start MCP server (stdio)
carly profile whoami            # Confirm identity + key validity
```

### Calendars

```bash
carly calendars list            # Connected calendars (provider + account + key)
```

Use `calendar_key` values from this list as the `--calendar-key` argument when creating/updating booking pages.

### Booking pages (5 commands)

```bash
carly booking-pages list
carly booking-pages get <event-type-id>

carly booking-pages create --title <title> [options]
  --slug <slug>                 # URL slug (e.g. "15min")
  --description <text>
  --duration <min>              # Meeting length (default 30)
  --location <loc>              # Physical location or URL
  --video-provider <name>       # google_meet, teams, zoom, ...
  --calendar-key <key>          # From `carly calendars list`
  --timezone <tz>               # IANA TZ (e.g. America/New_York)
  --username <username>         # Profile username (lowercase)
  --display-name <name>
  --event-name-template <tpl>
  --min-notice-minutes <n>      # Default 120
  --max-days-ahead <n>          # Default 60
  --before-event-buffer <min>
  --after-event-buffer <min>
  --slot-interval <min>
  --availability <json>         # [{"days":[1,2,3,4,5],"start_time":"09:00","end_time":"17:00"}]
  --custom-questions <json>     # [{"label":"Company","type":"text","required":true}]
  --duration-options <list>     # CSV (15,30,60) or JSON array ([15,30,60])

carly booking-pages update <event-type-id> [options]   # Same flags as create, all optional
  --is-active <true|false>      # Enable or disable the page

carly booking-pages delete <event-type-id>             # Soft-delete: sets is_active=false. Re-activate with `update <id> --is-active true`.
```

Nested-field notes:
- `--availability` days are numbered Sunday=0, Monday=1, …, Saturday=6. Times are HH:MM in the page's timezone.
- `--custom-questions` `type` is one of `text`, `textarea`, `number`, `phone`, `email`, `select`, `checkbox`, `radio`, `boolean`. `options` is only required for `select`/`radio`.
- On `update`, any nested field you pass **replaces** the previous value wholesale — there is no partial merge.
- MCP callers may pass these as native arrays/objects instead of stringified JSON.

### Event types

```bash
carly event-types list                          # Caller's own event types
carly event-types list --username <username>    # Public active event types for a profile
```

### Slots

```bash
carly slots list --event-type-id <id> --start-time <iso> --end-time <iso> [--duration <min>]

# or, public access via profile+slug:
carly slots list --username <username> --event-type-slug <slug> \
  --start-time <iso> --end-time <iso>
```

### Bookings

```bash
carly bookings list [options]
  --status <status>             # accepted, cancelled, rescheduled, ...
  --event-type-id <id>
  --limit <n>                   # 1–1000, default 100
  --start-time <iso>
  --end-time <iso>

carly bookings get <uid>
```

`bookings:write` (create, cancel, reschedule) is intentionally not exposed on this CLI or the MCP surface; use the web dashboard.

## Output formats

Every data-returning command accepts these global/per-command flags:

| Flag | Behavior |
|------|----------|
| `--output json` (default) | Single-line JSON to stdout |
| `--output pretty` | Pretty-printed JSON |
| `--pretty` | Shortcut for `--output pretty` |
| `--output table` | Fixed-width table; columns come from the command's `defaultColumns` (or scalar keys of the first row) |
| `--fields <a,b,c>` | Narrow JSON keys; override table columns |
| `--quiet` | Suppress stdout (exit code only) |

Table mode flattens Carly's `{items: [...]}` envelope and the `{slots: {date: [...]}}` map automatically. For single-object responses (e.g. `bookings get`), table mode falls back to pretty JSON with a note on stderr.

```bash
# Default compact JSON
carly bookings list

# Human-friendly table
carly bookings list --output table

# Just the columns you care about
carly bookings list --output table --fields uid,status,start_time

# Pretty JSON with a field filter
carly bookings list --fields uid,status,start_time --pretty
```

## Scopes

| Scope | Needed for |
|-------|------------|
| `booking_pages:read` | `calendars list`, `booking-pages list/get`, `event-types list` (own), `slots list` (own event type) |
| `booking_pages:write` | `booking-pages create/update/delete` |
| `bookings:read` | `bookings list`, `bookings get` |

`bookings:write` is not accepted when minting new keys and is not surfaced on this CLI or the MCP server. Existing keys that were minted with it still authenticate, but no write paths are wired up for bookings.

## Architecture

```
src/
├── index.ts                 # CLI entry (Commander.js)
├── mcp.ts                   # MCP entry (re-exports server.ts)
├── core/
│   ├── types.ts             # CommandDefinition — single source of truth
│   ├── client.ts            # CarlyClient (fetch + retry/backoff)
│   ├── auth.ts              # Flag → env → config resolution
│   ├── config.ts            # ~/.carly-cli/config.json (mode 0600)
│   ├── handler.ts           # executeCommand (path/query/body routing)
│   ├── output.ts            # json | pretty | table renderer + --fields
│   └── errors.ts            # AuthError, NotFoundError, RateLimitError, ...
├── commands/
│   ├── index.ts             # allCommands registry + Commander wiring
│   ├── auth/                # login, logout, auth-status
│   ├── profile/             # whoami
│   ├── calendars/           # list
│   ├── booking-pages/       # list, get, create, update, delete
│   ├── event-types/         # list
│   ├── slots/               # list
│   └── bookings/            # list, get
└── mcp/
    └── server.ts            # Register every CommandDefinition as an MCP tool
```

Each `CommandDefinition` carries:

- **name** — MCP tool name (e.g. `booking_pages_update`)
- **group / subcommand** — CLI routing (e.g. `carly booking-pages update`)
- **inputSchema** — Zod schema shared by CLI validation and MCP input schema
- **endpoint** — HTTP method + path template (e.g. `PATCH /booking-pages/{eventTypeId}`)
- **fieldMappings** — per-field routing to `path`, `query`, or `body`
- **defaultColumns** — optional; columns used by `--output table`
- **handler** — executes via `CarlyClient`

## Development

```bash
git clone https://github.com/usecarly/carly-cli.git
cd carly-cli
npm install

# Hot reload via tsx (no build step)
npm run dev -- profile whoami --pretty
npm run dev -- bookings list --output table

# Typecheck only
npm run typecheck

# Production build
npm run build           # → dist/index.js + dist/mcp.js
npm link                # expose `carly` on PATH
```

To add a command:

1. Author a `CommandDefinition` in `src/commands/<group>/index.ts`
2. Export it from the group's `*Commands` array
3. Include the group in `src/commands/index.ts` → `allCommands`
4. `npm run build && carly <group> <subcommand> --help`

Both the CLI and the MCP server pick it up automatically.

## License

MIT
