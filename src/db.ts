import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Provider } from "./types.js";

interface TokenRow {
  provider: Provider;
  access_token: string;
  refresh_token: string;
  expiry_ts: number;
  scopes: string | null;
  updated_at: string;
}

export interface EventMapping {
  outlookEventId: string;
  googleEventId: string;
  outlookIcalUid: string | null;
  outlookLastModified: string | null;
  googleEtag: string | null;
  isRecurringMaster: boolean;
  seriesMasterId: string | null;
  lastSyncedAt: string;
}

export class DbClient {
  private readonly db: Database.Database;

  constructor(sqlitePath: string) {
    const dir = path.dirname(sqlitePath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(sqlitePath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expiry_ts INTEGER NOT NULL,
        scopes TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS event_mappings (
        outlook_event_id TEXT PRIMARY KEY,
        google_event_id TEXT NOT NULL UNIQUE,
        outlook_ical_uid TEXT,
        outlook_last_modified TEXT,
        google_etag TEXT,
        is_recurring_master INTEGER NOT NULL DEFAULT 0,
        series_master_id TEXT,
        last_synced_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  close() {
    this.db.close();
  }

  getToken(provider: Provider): TokenRow | undefined {
    const stmt = this.db.prepare(`
      SELECT provider, access_token, refresh_token, expiry_ts, scopes, updated_at
      FROM oauth_tokens
      WHERE provider = ?
    `);
    return stmt.get(provider) as TokenRow | undefined;
  }

  upsertToken(row: TokenRow) {
    const stmt = this.db.prepare(`
      INSERT INTO oauth_tokens (provider, access_token, refresh_token, expiry_ts, scopes, updated_at)
      VALUES (@provider, @access_token, @refresh_token, @expiry_ts, @scopes, @updated_at)
      ON CONFLICT(provider) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expiry_ts = excluded.expiry_ts,
        scopes = excluded.scopes,
        updated_at = excluded.updated_at
    `);
    stmt.run(row);
  }

  getMapping(outlookEventId: string): EventMapping | undefined {
    const stmt = this.db.prepare(`
      SELECT
        outlook_event_id AS outlookEventId,
        google_event_id AS googleEventId,
        outlook_ical_uid AS outlookIcalUid,
        outlook_last_modified AS outlookLastModified,
        google_etag AS googleEtag,
        is_recurring_master AS isRecurringMaster,
        series_master_id AS seriesMasterId,
        last_synced_at AS lastSyncedAt
      FROM event_mappings
      WHERE outlook_event_id = ?
    `);
    const row = stmt.get(outlookEventId) as EventMapping | undefined;
    if (!row) {
      return undefined;
    }
    return {
      ...row,
      isRecurringMaster: Boolean(row.isRecurringMaster),
    };
  }

  listMappings(): EventMapping[] {
    const stmt = this.db.prepare(`
      SELECT
        outlook_event_id AS outlookEventId,
        google_event_id AS googleEventId,
        outlook_ical_uid AS outlookIcalUid,
        outlook_last_modified AS outlookLastModified,
        google_etag AS googleEtag,
        is_recurring_master AS isRecurringMaster,
        series_master_id AS seriesMasterId,
        last_synced_at AS lastSyncedAt
      FROM event_mappings
    `);
    const rows = stmt.all() as EventMapping[];
    return rows.map((row) => ({
      ...row,
      isRecurringMaster: Boolean(row.isRecurringMaster),
    }));
  }

  upsertMapping(mapping: EventMapping) {
    const stmt = this.db.prepare(`
      INSERT INTO event_mappings (
        outlook_event_id,
        google_event_id,
        outlook_ical_uid,
        outlook_last_modified,
        google_etag,
        is_recurring_master,
        series_master_id,
        last_synced_at
      )
      VALUES (
        @outlookEventId,
        @googleEventId,
        @outlookIcalUid,
        @outlookLastModified,
        @googleEtag,
        @isRecurringMaster,
        @seriesMasterId,
        @lastSyncedAt
      )
      ON CONFLICT(outlook_event_id) DO UPDATE SET
        google_event_id = excluded.google_event_id,
        outlook_ical_uid = excluded.outlook_ical_uid,
        outlook_last_modified = excluded.outlook_last_modified,
        google_etag = excluded.google_etag,
        is_recurring_master = excluded.is_recurring_master,
        series_master_id = excluded.series_master_id,
        last_synced_at = excluded.last_synced_at
    `);

    stmt.run({
      ...mapping,
      isRecurringMaster: mapping.isRecurringMaster ? 1 : 0,
    });
  }

  deleteMapping(outlookEventId: string) {
    const stmt = this.db.prepare(`DELETE FROM event_mappings WHERE outlook_event_id = ?`);
    stmt.run(outlookEventId);
  }

  setState(key: string, value: string) {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(key, value);
  }

  getState(key: string): string | undefined {
    const stmt = this.db.prepare(`SELECT value FROM sync_state WHERE key = ?`);
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }
}
