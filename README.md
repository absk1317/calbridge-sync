# Outlook -> Google Calendar Sync Daemon

A local Node.js daemon that mirrors Outlook calendar sources into Google Calendar.

## What it supports

- One-way sync into Google Calendar.
- Many-to-1 architecture: multiple source subscriptions can sync into one target Google calendar.
- Source modes per subscription:
  - `microsoft` (Microsoft Graph API via OAuth)
  - `ics` (published Outlook ICS feed, no Microsoft OAuth)
- Poll interval configurable (default 5 minutes).
- Sync window configurable (default past 7 days + next 15 days).
- Recurring events, updates, and deletes/cancellations are reconciled in-window.

## Prerequisites

- Node.js 20+
- Google OAuth client credentials
- For Microsoft source subscriptions: Azure app registration with delegated `Calendars.Read`
- For ICS source subscriptions: published Outlook ICS URL(s)

## Google OAuth setup

1. In Google Cloud Console, create OAuth Client ID.
2. Add redirect URI:
   - `http://127.0.0.1:53682/oauth2callback`
3. Copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Microsoft app setup (for `microsoft` subscriptions)

1. Azure Portal -> App registrations -> New registration.
2. Enable **Allow public client flows**.
3. Add delegated Microsoft Graph permission: `Calendars.Read`.
4. Grant admin consent if your tenant policy requires it.
5. Note client ID and tenant ID.

## Install

```bash
npm install
cp .env.example .env
cp subscriptions.example.json subscriptions.json
# edit both .env and subscriptions.json
```

Set `TOKEN_ENCRYPTION_KEY` to a strong secret (at least 16 chars).
Example:

```bash
openssl rand -base64 48
```

## Configuration

### 1) `.env` (global settings)

Key fields:
- `SUBSCRIPTIONS_FILE=./subscriptions.json`
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
- `GOOGLE_TARGET_CALENDAR_ID` (default target calendar fallback)
- `TOKEN_ENCRYPTION_KEY`
- `SYNC_INTERVAL_SECONDS`, `SYNC_LOOKBACK_DAYS`, `SYNC_LOOKAHEAD_DAYS`
- `SQLITE_PATH`

You can still run legacy single-subscription mode (without `subscriptions.json`) via:
- `SOURCE_MODE`
- `OUTLOOK_ICS_URL`
- `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`

### 2) `subscriptions.json` (many-to-1 source definitions)

Use `subscriptions.example.json` as a template.

```json
{
  "subscriptions": [
    {
      "id": "work-ics",
      "enabled": true,
      "sourceMode": "ics",
      "outlookIcsUrl": "https://outlook.office.com/.../calendar.ics",
      "googleTargetCalendarId": "your_target_calendar_id@group.calendar.google.com"
    },
    {
      "id": "work-microsoft",
      "enabled": true,
      "sourceMode": "microsoft",
      "microsoftClientId": "your-client-id",
      "microsoftTenantId": "your-tenant-id",
      "googleTargetCalendarId": "your_target_calendar_id@group.calendar.google.com"
    }
  ]
}
```

Notes:
- `id` must be unique.
- `enabled` controls whether a subscription is active.
- `googleTargetCalendarId` can be omitted when `GOOGLE_TARGET_CALENDAR_ID` is set in `.env`.

## Authenticate

Google (once per Google account):

```bash
npm run dev -- auth:google
```

Microsoft (run once per Microsoft subscription id):

```bash
npm run dev -- auth:microsoft --subscription work-microsoft
```

If only one Microsoft subscription exists, `--subscription` can be omitted.

## Run

One batch cycle across all enabled subscriptions:

```bash
npm run dev -- once
```

Health checks (Google + every enabled subscription source):

```bash
npm run dev -- health
```

Long-running daemon:

```bash
npm run dev -- start
```

Build and run compiled output:

```bash
npm run build
npm run once
npm run start
```

## Cron setup (macOS and Linux)

Use cron for periodic one-shot runs.

### Recommended: interactive script

```bash
npm run build
npm run cron-setup
```

The script prompts for:
- repository directory
- node binary path
- polling interval (minutes)
- log file path

It installs/updates a managed crontab block safely.

### Manual cron entry

```cron
*/5 * * * * cd /absolute/path/to/outlook-google-calendar-sync && /absolute/path/to/node dist/src/cli.js once >> /absolute/path/to/outlook-google-calendar-sync/logs/cron-sync.log 2>&1
```

## Storage and state

- SQLite stores:
  - OAuth tokens (encrypted)
  - event mappings (subscription-scoped)
  - sync state (subscription-scoped)
- Existing single-subscription DB data is migrated automatically to subscription id `default`.
