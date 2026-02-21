# CalBridge Sync

A local Node.js daemon that bridges Microsoft, ICS, and Google calendar sources into Google Calendar.

## What it supports

- One-way sync into Google Calendar.
- Many-to-1 architecture: multiple source subscriptions can sync into one target Google calendar.
- Source modes per subscription:
  - `microsoft` (Microsoft Graph API via OAuth)
  - `ics` (published Outlook ICS feed, no Microsoft OAuth)
  - `google` (Google Calendar API via OAuth, private calendars supported)
- Poll interval configurable (default 5 minutes).
- Sync window configurable (default past 7 days + next 15 days).
- Recurring events, updates, and deletes/cancellations are reconciled in-window.

## Prerequisites

- Node.js 20+
- Google OAuth client credentials
- For Microsoft source subscriptions: Azure app registration with delegated `Calendars.Read`
- For ICS source subscriptions: published Outlook ICS URL(s)
- For Google source subscriptions: source calendar id (`googleSourceCalendarId`) and Google OAuth token

## Google OAuth setup

1. In Google Cloud Console, create OAuth Client ID.
2. Add redirect URI:
   - `http://127.0.0.1:53682/oauth2callback`
3. Copy `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

Google Workspace policy note:
- Some org accounts block custom OAuth apps with `admin_policy_enforced`.
- If that happens, ask your admin to allow this app/scopes, or use an alternate source mode (`microsoft` or `ics`) for that account.

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
- `GOOGLE_SOURCE_CALENDAR_ID`
- `GOOGLE_SOURCE_TOKEN_KEY`
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
    },
    {
      "id": "work-google",
      "enabled": true,
      "sourceMode": "google",
      "googleSourceCalendarId": "source_calendar_id@group.calendar.google.com",
      "googleSourceTokenKey": "work-google",
      "googleTargetCalendarId": "your_target_calendar_id@group.calendar.google.com"
    }
  ]
}
```

Notes:
- `id` must be unique.
- `enabled` controls whether a subscription is active.
- `googleTargetCalendarId` can be omitted when `GOOGLE_TARGET_CALENDAR_ID` is set in `.env`.
- `googleSourceTokenKey` defaults to `default` and selects which Google OAuth token is used for source reads.
- `googleSourceCalendarId` is the source calendar id shown in Google Calendar settings (`Integrate calendar` -> `Calendar ID`).
- Managed events now store neutral source markers (`source_event_id`, `source_mode`) while preserving legacy compatibility markers.

## Authenticate

Google (once per Google account):

```bash
npm run dev -- auth:google
```

Google with explicit token key (useful when source and target use different Google accounts):

```bash
npm run dev -- auth:google --token-key work-google
```

Microsoft (run once per Microsoft subscription id):

```bash
npm run dev -- auth:microsoft --subscription work-microsoft
```

If only one Microsoft subscription exists, `--subscription` can be omitted.

For `sourceMode: "google"`, set `googleSourceTokenKey` on that subscription if source reads should use a non-default Google account token.

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

## Cleanup duplicate synced events

If migration or source changes created duplicate mirrored entries, use the built-in cleanup command.

Preview first (no changes):

```bash
npm run dev -- cleanup:managed --dry-run
```

Delete all app-managed sync events from resolved target calendars and reset local sync mappings/state:

```bash
npm run dev -- cleanup:managed --yes
```

Target specific subscriptions only:

```bash
npm run dev -- cleanup:managed --subscription work-ics --dry-run
npm run dev -- cleanup:managed --subscription work-ics --yes
```

Target specific calendar ids:

```bash
npm run dev -- cleanup:managed --calendar your_calendar_id@group.calendar.google.com --yes
```

After cleanup, run one sync cycle again:

```bash
npm run dev -- once
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
*/5 * * * * cd /absolute/path/to/calbridge-sync && /absolute/path/to/node dist/src/cli.js once >> /absolute/path/to/calbridge-sync/logs/cron-sync.log 2>&1
```

## Storage and state

- SQLite stores:
  - OAuth tokens (encrypted)
  - event mappings (subscription-scoped)
  - sync state (subscription-scoped)
- Existing single-subscription DB data is migrated automatically to subscription id `default`.

## License

Apache-2.0. See `LICENSE`.
