# carly-cli

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Carly Forms & Bookings** is the existing Carly CLI, expanded to manage forms alongside booking pages. The `carly` command, npm package `carly-ai`, saved credentials and existing MCP tool names stay compatible.

One command registry drives both the shell and `carly mcp`. It covers booking pages and their settings, working-hours schedules, private links, reminders, branding, team routing attributes, booking workflow connections, Calendly imports, forms and form submissions. Calendar, identity, slot and booking reads remain available for these workflows.

This is the local stdio MCP version of the CLI. The general Carly and Carly Teams hosted MCPs are separate products with their own setup; this package does not proxy those tools.

Version 0.4 adds form and booking-control commands that require the corresponding `/api/v1/forms` and booking-control API routes on your Carly server. Updating this package does not deploy that backend. Older servers continue to support the existing commands and may return 404 for the new ones.

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
carly login                   # paste a personal API key from /integrations (enable forms scopes for forms)
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
carly schedules list --output table
carly bookings list --output table
carly forms list --output table
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

Base URL defaults to `https://carlyassistant.com` and can be overridden with `--api-base-url` or `CARLY_API_BASE_URL`. The legacy `dashboard.carlyassistant.com` host serves the same API and still works.

Mint a personal key at `<base-url>/integrations#api-key-create-form` and select the scopes you need. Forms require `forms:read` and/or `forms:write`; these scopes are off by default. Booking keys can also be created on the booking-pages screen. Team credentials stay within their team and cannot access personal forms. Scopes and live resource permissions are enforced server-side; see [Scopes](#scopes) below.

## MCP server setup

`carly mcp` starts an MCP server over stdio that exposes every API command in the shared registry as a tool to any MCP-compatible client.

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
    "carly-forms-bookings": {
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
    "carly-forms-bookings": {
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

### Booking pages

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
  --date-overrides <json>       # [{"date":"2026-12-24","windows":[]}]  (empty windows = day blocked)
  --custom-questions <json>     # [{"label":"Company","type":"text","required":true}]
  --duration-options <list>     # CSV (15,30,60) or JSON array ([15,30,60])
  --widgets <json>              # Page content blocks
  --schedule-id <id>            # Book on a library schedule (see `carly schedules list`); omit to follow your default
  --schedule-name <name>        # Name for the schedule created from --availability/--timezone
  # Team pages
  --organization-id <id> --scheduling-type <round_robin|collective|managed>
  --hosts <json>                # [{"user_id":12,"is_fixed":false,"priority":1,"schedule_id":null}]
  --assign-all-team-members <true|false>  --member-fields-unlocked <true|false>
  --rr-reset-interval <day|month> --rr-timestamp-basis <created_at|start_time>
  --include-no-show-in-rr-calculation <true|false> --reschedule-with-same-round-robin-host <true|false>
  # Limits and windows
  --booking-window-mode <rolling|business_days|range> --booking-window-business-days <n>
  --booking-window-start <date> --booking-window-end <date>
  --booking-limit-count <n> --booking-limit-period <day|week|month|year> --booking-limit-duration-minutes <n>
  --booker-active-booking-limit <n> --offset-start-minutes <n> --only-show-first-available-slot <true|false>
  # Guest controls and privacy
  --requires-confirmation <true|false> --confirmation-threshold-minutes <n>
  --disable-guests / --disable-cancelling / --disable-rescheduling <true|false> --minimum-reschedule-notice <n>
  --hide-calendar-notes / --hide-calendar-event-details / --hide-organizer-email <true|false>
  --requires-private-link <true|false> --locked-timezone <tz> --color <#RRGGBB>
  --success-redirect-url <url> --forward-params-success-redirect <true|false>
  # Seats, recurrence, reminders
  --seats-per-time-slot <n> --seats-show-attendees <true|false> --seats-show-availability-count <true|false>
  --recurrence-frequency <weekly|monthly|yearly> --recurrence-interval <n> --recurrence-occurrences <n>
  --reminder-configs <json>

carly booking-pages update <event-type-id> [options]   # Same flags as create, all optional
  --is-active <true|false>      # Enable or disable the page

carly booking-pages delete <event-type-id>             # Soft-delete: sets is_active=false. Re-activate with `update <id> --is-active true`.
carly booking-pages check-username <username>        # Is this profile username free?
```

Nested-field notes:
- `--availability` days are numbered Sunday=0, Monday=1, …, Saturday=6. Times are HH:MM in the page's timezone.
- `--date-overrides` are one-off exceptions that **replace** the weekly hours for a single date, read in the page's timezone. `"windows": []` blocks the date entirely; otherwise only the listed windows are bookable. An override can also open a date the weekly pattern leaves closed. Max 100 overrides / 500 windows per page.
- `--availability` and `--date-overrides` are independent — updating one leaves the other intact. Pass `--date-overrides '[]'` to clear every override without touching the weekly hours.
- `--custom-questions` `type` is one of `text`, `textarea`, `number`, `phone`, `email`, `select`, `checkbox`, `radio`, `boolean`. `options` is only required for `select`/`radio`.
- On `update`, any nested field you pass **replaces** the previous value wholesale — there is no partial merge.
- MCP callers may pass these as native arrays/objects instead of stringified JSON.

### Schedules (6 commands)

Working hours live in a library of schedules, not on the page. You have one **default** (every page without `--schedule-id` follows it); a team can own shared schedules a team page imposes on every host. `booking-pages update --availability` edits the page's own schedule — or, for a page that follows your default, gives it a copy of its own.

```bash
carly schedules list --output table
carly schedules get <schedule-id>                       # hours, overrides, timezone, and the pages using it
carly schedules create --name "Working hours" --timezone America/New_York --availability '<json>'
carly schedules create --name "Front desk" --organization-id 4 --timezone America/Chicago --availability '<json>'
carly schedules create --for-user-id 388                # seed a 9-5 default for a team member with no hours
carly schedules update <schedule-id> --timezone Europe/Berlin --availability '<json>' --date-overrides '<json>'
carly schedules duplicate <schedule-id> --data '{"name":"Summer hours"}'
carly schedules set-default <schedule-id>
carly schedules delete <schedule-id>                    # refused while a page uses it
```

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

### Forms

```bash
carly forms list
carly forms get 42
carly forms create --name "Watch the video" \
  --form-fields '[{"key":"email","label":"Email","type":"email","required":true}]' \
  --routes '{"rules":[],"fallback":{"type":"redirect","url":"https://example.com/watch"}}'
carly forms update 42 --form-fields @fields.json --notify-email false
carly forms update 42 --routes null                 # clear routing
carly forms update 42 --status paused
carly forms submissions 42 --limit 50 --offset 0
carly forms routing-targets
carly forms crm-fields
carly forms phone-regions
carly forms test-routing --form-fields @fields.json --routes @routes.json --answers '{"email":"guest@example.com"}'
carly forms upload-logo --content-base64 @logo.png --mime-type image/png
carly forms delete 42
```

`--form-fields` edits the form; `--fields` retains its existing output-filtering meaning. Create and update also support `--intro-text`, `--submit-label`, `--success-message`, `--legal`, `--appearance`, `--webhook-url` and `--status`. Nested JSON accepts inline JSON or `@file`; MCP clients can supply native objects and arrays. Save the logo upload's `logo_key` in `appearance.logo_key`. Send an empty webhook URL to remove a webhook. Only supplied settings change, and explicit `null` clears routing, legal or appearance. Keep existing field keys when editing labels so routing and workflows retain their references.

Removing workflow-bound fields requires `forms update --force`. Deleting a form with dependent workflows requires `forms delete --force`, which pauses those workflows and permanently deletes the form and its submissions.

### Booking controls

These commands use the same validation and permissions as the booking editor. `--data` accepts the documented JSON body or `@file`. Run each command with `--help` for its body shape.

```bash
carly private-links list 7
carly private-links create 7 --data '{"max_usage_count":1}'
carly private-links revoke 7 12
carly booking-reminders preview 7 --data @reminder.json
carly booking-reminders test 7 --data @reminder.json
carly booking-reminders insights 7
carly booking-connections list 7
carly booking-connections setup 7 --template-id TEMPLATE_ID
carly booking-connections create 7 --data @connection.json
carly booking-branding get
carly booking-branding update --data '{"display_name":"My business"}'
carly booking-branding upload-logo --content-base64 @logo.png --mime-type image/png
carly booking-branding delete-logo
carly booking-branding set-removal 2 --data '{"hide_carly_branding":true}'
carly booking-attributes list 2
carly booking-attributes create 2 --data @attribute.json
carly booking-attributes update 2 4 --data '{"enabled":false}'
carly booking-attributes assign 2 3 4 --data '{"values":["East"],"weight":100}'
carly booking-attributes delete 2 4
carly booking-import preview --data @calendly-token.json
carly booking-import calendly --data @calendly-import.json
```

Branding commands accept `--org <id>` for an authorized team. Attribute assignment arguments are organization ID, membership ID, then attribute ID; use option IDs for select attributes and scalar values for text/number attributes. Reminder tests send to your own email and retain the server's rate limits. Private-link URLs grant booking access; keep them private.

Booking page create/update already include redirect URLs, forwarded query parameters, recurring meetings, team hosts, routing rules, custom questions, reminders, availability, limits and content blocks. Use `--help` for the complete options. For example:

```bash
carly booking-pages update 7 --success-redirect-url https://example.com/watch
carly booking-pages update 7 --success-redirect-url null
carly booking-pages update 7 --recurrence-frequency null
```

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
| `booking_pages:read` | `calendars list`, `booking-pages list/get`, `event-types list` (own), `slots list` (own event type), schedules, private links, branding, attributes, connection setup, reminder previews/insights and import previews |
| `booking_pages:write` | Booking page writes, schedule writes, private-link writes, reminder tests, branding, attributes and imports |
| `forms:read` | Form list/get, submissions, routing targets, CRM fields, phone regions and routing tests |
| `forms:write` | Form create/update/delete and logo upload |
| `workflows:write` + `booking_pages:write` | Creating a booking workflow connection |
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
│   ├── forms/               # forms, routing, submissions, logos
│   ├── booking-controls/    # private links, reminders, branding, attributes, imports
│   ├── schedules/           # working hours and date overrides
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

# Validation
npm run typecheck
npm test
npm run fields:check

# Production build
npm run build           # → dist/index.js + dist/mcp.js
npm link                # expose `carly` on PATH
```

To add a command:

1. Author a `CommandDefinition` in `src/commands/<group>/index.ts`
2. Export it from the group's `*Commands` array
3. Include the group in `src/commands/index.ts` → `allCommands`
4. `npm run build && carly <group> <subcommand> --help`

Both the CLI and the MCP server pick it up automatically. The field check covers booking-page, schedule and form create/update inputs. It uses a sibling backend checkout when present, otherwise the public snapshot in `schemas/api_v1_fields.txt`; set `CARLY_API_FIELDS_FILE` to override it. Refresh that snapshot alongside server schema changes.

Read requests retry transient failures. Writes are never automatically retried because creating a form, sending a test reminder or importing pages may already have taken effect.

## License

MIT
