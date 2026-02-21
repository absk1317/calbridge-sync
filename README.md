# Outlook -> Google Calendar Sync Daemon

A local Node.js daemon that mirrors Outlook (Microsoft 365) events into a dedicated Google Calendar.

## Behavior (v1)

- One-way sync: Outlook -> Google.
- Poll interval: every 5 minutes by default.
- Sync window: past 7 days + next 15 days.
- Recurring meetings are mirrored by syncing calendar-view instances (including exceptions/cancellations in window).
- Outlook is source of truth: mirrored Google events are overwritten on each sync.
- If Outlook events are canceled/deleted/out of window, mirrored Google events are deleted.

## Prerequisites

- Node.js 20+
- A Microsoft app registration (public client) for device-code OAuth.
- A Google OAuth client (Desktop app or Web app with loopback redirect URI).

## Microsoft Azure App Setup

1. Go to Azure Portal -> App registrations -> New registration.
2. Create a public client app.
3. Enable **Allow public client flows**.
4. Add delegated Microsoft Graph permission: `Calendars.Read`.
5. Copy the Application (client) ID to `MICROSOFT_CLIENT_ID`.
6. Set `MICROSOFT_TENANT_ID` (`common` works for many tenants; use your tenant ID if required by policy).

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
npm run dev -- auth:microsoft
npm run dev -- auth:google
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

## Notes

- Tokens and sync state are stored in SQLite at `SQLITE_PATH`.
- OAuth tokens are encrypted before being written to SQLite.
- This app only manages events it created (tracked in local mapping DB).
