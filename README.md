# Outlook -> Google Calendar Sync Daemon

A local Node.js daemon that mirrors Outlook (Microsoft 365) events into a dedicated Google Calendar.

## Behavior (v1)

- One-way sync: Outlook -> Google.
- Poll interval: every 5 minutes by default.
- Sync window: past 7 days + next 15 days.
- Recurring meetings are mirrored by syncing calendar-view instances (including exceptions/cancellations in window).
- Outlook is source of truth: mirrored Google events are overwritten on each sync.
- If Outlook events are canceled/deleted/out of window, mirrored Google events are deleted.
- Two source modes are supported:
  - `SOURCE_MODE=microsoft` (Graph API via OAuth)
  - `SOURCE_MODE=ics` (published Outlook ICS feed, no Microsoft OAuth)

## Prerequisites

- Node.js 20+
- A Google OAuth client (Desktop app or Web app with loopback redirect URI).
- For `SOURCE_MODE=microsoft`: a Microsoft app registration (public client) for device-code OAuth.
- For `SOURCE_MODE=ics`: a published Outlook calendar ICS URL.

## Microsoft Azure App Setup

1. Go to Azure Portal -> App registrations -> New registration.
2. Create a public client app.
3. Enable **Allow public client flows**.
4. Add delegated Microsoft Graph permission: `Calendars.Read`.
5. Copy the Application (client) ID to `MICROSOFT_CLIENT_ID`.
6. Set `MICROSOFT_TENANT_ID` (`common` works for many tenants; use your tenant ID if required by policy).

## Outlook ICS Feed Setup (No Microsoft OAuth)

1. In Outlook on the web, open calendar publishing/sharing settings.
2. Publish the calendar with an ICS link.
3. Copy the secret ICS URL into `OUTLOOK_ICS_URL`.
4. Set `SOURCE_MODE=ics`.

Notes:
- In `ics` mode you do not run `auth:microsoft`.
- Data freshness and recurrence fidelity depend on what your published feed contains.

## Google OAuth App Setup

1. Go to Google Cloud Console -> APIs & Services -> Credentials.
2. Create OAuth Client ID.
3. Add redirect URI:
   - `http://127.0.0.1:53682/oauth2callback`
   - If you change `GOOGLE_OAUTH_REDIRECT_PORT`, update URI accordingly.
4. Copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
5. Create or choose a dedicated target Google calendar and copy its calendar ID to `GOOGLE_TARGET_CALENDAR_ID`.

## Install

```bash
npm install
cp .env.example .env
# edit .env with your values
```

Set `TOKEN_ENCRYPTION_KEY` to a strong secret (at least 16 chars). You can generate a random key using `openssl rand -base64 48`.

## Authenticate

```bash
npm run dev -- auth:google
```

For Microsoft Graph mode only:

```bash
npm run dev -- auth:microsoft
```

## Run Commands

One sync cycle:

```bash
npm run dev -- once
```

Health check:

```bash
npm run dev -- health
```

Long-running daemon:

```bash
npm run dev -- start
```

## Cron Setup (macOS and Linux)

Use cron if you want periodic one-shot runs instead of a long-lived process.

### Recommended: interactive setup script

1. Build first:

```bash
npm run build
```

2. Run the setup script:

```bash
npm run cron-setup
```

The script asks for:
- repository directory
- node binary path
- polling interval in minutes (1-59)
- log file path

It then installs or updates a managed cron block in your user crontab.
Re-running `npm run cron-setup` replaces the previous managed block safely.

### Manual setup (alternative)

```bash
mkdir -p logs
which node
crontab -e
```

Add a line like:

```cron
*/5 * * * * cd /absolute/path/to/outlook-google-calendar-sync && /absolute/path/to/node dist/src/cli.js once >> /absolute/path/to/outlook-google-calendar-sync/logs/cron-sync.log 2>&1
```

Notes:
- Use absolute paths for both repo directory and `node`.
- Cron does not load your shell profile, so `nvm` paths are often missing unless you use absolute paths.
- Cron runs only while the machine is on (and not asleep).
- If you change TypeScript source, rerun `npm run build` before cron uses new code.
- Verify installed entries with `crontab -l`.

## Notes

- Tokens and sync state are stored in SQLite at `SQLITE_PATH`.
- OAuth tokens are encrypted before being written to SQLite.
- This app only manages events it created (tracked in local mapping DB).
