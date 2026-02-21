import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Provider } from "./types.js";

interface TokenRow {
  provider: Provider;
  token_key: string;
  access_token: string;
  refresh_token: string;
  expiry_ts: number;
  scopes: string | null;
  updated_at: string;
}

export interface EventMapping {
  subscriptionId: string;
  sourceEventId: string;
  googleEventId: string;
  sourceIcalUid: string | null;
  sourceLastModified: string | null;
  googleEtag: string | null;
  isRecurringMaster: boolean;
  seriesMasterId: string | null;
  lastSyncedAt: string;
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName) as { name: string } | undefined;
  return Boolean(row?.name);
}

function tableHasColumn(db: Database.Database, tableName: string, columnName: string): boolean {
  if (!tableExists(db, tableName)) {
    return false;
  }

  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function ensureOauthTokensSchema(db: Database.Database) {
  const hasLegacyTable = tableExists(db, "oauth_tokens");
  const hasTokenKey = tableHasColumn(db, "oauth_tokens", "token_key");

  if (!hasLegacyTable) {
    db.exec(`
      CREATE TABLE oauth_tokens (
        provider TEXT NOT NULL,
        token_key TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        expiry_ts INTEGER NOT NULL,
        scopes TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, token_key)
      );
    `);
    return;
  }

  if (hasTokenKey) {
    return;
  }

  db.exec(`
    CREATE TABLE oauth_tokens_new (
      provider TEXT NOT NULL,
      token_key TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expiry_ts INTEGER NOT NULL,
      scopes TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider, token_key)
    );

    INSERT INTO oauth_tokens_new (
      provider,
      token_key,
      access_token,
      refresh_token,
      expiry_ts,
      scopes,
      updated_at
    )
    SELECT
      provider,
      'default' AS token_key,
      access_token,
      refresh_token,
      expiry_ts,
      scopes,
      updated_at
    FROM oauth_tokens;

    DROP TABLE oauth_tokens;
    ALTER TABLE oauth_tokens_new RENAME TO oauth_tokens;
  `);
}

function ensureEventMappingsSchema(db: Database.Database) {
  const hasLegacyTable = tableExists(db, "event_mappings");
  const hasSubscriptionId = tableHasColumn(db, "event_mappings", "subscription_id");
  const hasSourceEventId = tableHasColumn(db, "event_mappings", "source_event_id");

  if (!hasLegacyTable) {
    db.exec(`
      CREATE TABLE event_mappings (
        subscription_id TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        google_event_id TEXT NOT NULL,
        source_ical_uid TEXT,
        source_last_modified TEXT,
        google_etag TEXT,
        is_recurring_master INTEGER NOT NULL DEFAULT 0,
        series_master_id TEXT,
        last_synced_at TEXT NOT NULL,
        PRIMARY KEY (subscription_id, source_event_id),
        UNIQUE (subscription_id, google_event_id)
      );

      CREATE INDEX idx_event_mappings_subscription_id
        ON event_mappings(subscription_id);
    `);
    return;
  }

  if (hasSubscriptionId && hasSourceEventId) {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_event_mappings_subscription_google
        ON event_mappings(subscription_id, google_event_id);
      CREATE INDEX IF NOT EXISTS idx_event_mappings_subscription_id
        ON event_mappings(subscription_id);
    `);
    return;
  }

  db.exec(`
    CREATE TABLE event_mappings_new (
      subscription_id TEXT NOT NULL,
      source_event_id TEXT NOT NULL,
      google_event_id TEXT NOT NULL,
      source_ical_uid TEXT,
      source_last_modified TEXT,
      google_etag TEXT,
      is_recurring_master INTEGER NOT NULL DEFAULT 0,
      series_master_id TEXT,
      last_synced_at TEXT NOT NULL,
      PRIMARY KEY (subscription_id, source_event_id),
      UNIQUE (subscription_id, google_event_id)
    );

    INSERT INTO event_mappings_new (
      subscription_id,
      source_event_id,
      google_event_id,
      source_ical_uid,
      source_last_modified,
      google_etag,
      is_recurring_master,
      series_master_id,
      last_synced_at
    )
    SELECT
      'default' AS subscription_id,
      outlook_event_id AS source_event_id,
      google_event_id,
      outlook_ical_uid AS source_ical_uid,
      outlook_last_modified AS source_last_modified,
      google_etag,
      is_recurring_master,
      series_master_id,
      last_synced_at
    FROM event_mappings;

    DROP TABLE event_mappings;
    ALTER TABLE event_mappings_new RENAME TO event_mappings;

    CREATE INDEX idx_event_mappings_subscription_id
      ON event_mappings(subscription_id);
  `);
}

function ensureSyncStateSchema(db: Database.Database) {
  const hasLegacyTable = tableExists(db, "sync_state");
  const hasSubscriptionId = tableHasColumn(db, "sync_state", "subscription_id");

  if (!hasLegacyTable) {
    db.exec(`
      CREATE TABLE sync_state (
        subscription_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (subscription_id, key)
      );
    `);
    return;
  }

  if (hasSubscriptionId) {
    return;
  }

  db.exec(`
    CREATE TABLE sync_state_new (
      subscription_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (subscription_id, key)
    );

    INSERT INTO sync_state_new (subscription_id, key, value)
    SELECT 'default' AS subscription_id, key, value
    FROM sync_state;

    DROP TABLE sync_state;
    ALTER TABLE sync_state_new RENAME TO sync_state;
  `);
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
    this.db.exec("BEGIN");
    try {
      ensureOauthTokensSchema(this.db);
      ensureEventMappingsSchema(this.db);
      ensureSyncStateSchema(this.db);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  getToken(provider: Provider, tokenKey = "default"): TokenRow | undefined {
    const stmt = this.db.prepare(`
      SELECT provider, token_key, access_token, refresh_token, expiry_ts, scopes, updated_at
      FROM oauth_tokens
      WHERE provider = ? AND token_key = ?
    `);
    return stmt.get(provider, tokenKey) as TokenRow | undefined;
  }

  upsertToken(row: TokenRow) {
    const stmt = this.db.prepare(`
      INSERT INTO oauth_tokens (
        provider,
        token_key,
        access_token,
        refresh_token,
        expiry_ts,
        scopes,
        updated_at
      )
      VALUES (
        @provider,
        @token_key,
        @access_token,
        @refresh_token,
        @expiry_ts,
        @scopes,
        @updated_at
      )
      ON CONFLICT(provider, token_key) DO UPDATE SET
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        expiry_ts = excluded.expiry_ts,
        scopes = excluded.scopes,
        updated_at = excluded.updated_at
    `);
    stmt.run(row);
  }

  getMapping(subscriptionId: string, sourceEventId: string): EventMapping | undefined {
    const stmt = this.db.prepare(`
      SELECT
        subscription_id AS subscriptionId,
        source_event_id AS sourceEventId,
        google_event_id AS googleEventId,
        source_ical_uid AS sourceIcalUid,
        source_last_modified AS sourceLastModified,
        google_etag AS googleEtag,
        is_recurring_master AS isRecurringMaster,
        series_master_id AS seriesMasterId,
        last_synced_at AS lastSyncedAt
      FROM event_mappings
      WHERE subscription_id = ? AND source_event_id = ?
    `);
    const row = stmt.get(subscriptionId, sourceEventId) as EventMapping | undefined;
    if (!row) {
      return undefined;
    }
    return {
      ...row,
      isRecurringMaster: Boolean(row.isRecurringMaster),
    };
  }

  listMappings(subscriptionId: string): EventMapping[] {
    const stmt = this.db.prepare(`
      SELECT
        subscription_id AS subscriptionId,
        source_event_id AS sourceEventId,
        google_event_id AS googleEventId,
        source_ical_uid AS sourceIcalUid,
        source_last_modified AS sourceLastModified,
        google_etag AS googleEtag,
        is_recurring_master AS isRecurringMaster,
        series_master_id AS seriesMasterId,
        last_synced_at AS lastSyncedAt
      FROM event_mappings
      WHERE subscription_id = ?
    `);
    const rows = stmt.all(subscriptionId) as EventMapping[];
    return rows.map((row) => ({
      ...row,
      isRecurringMaster: Boolean(row.isRecurringMaster),
    }));
  }

  upsertMapping(mapping: EventMapping) {
    const stmt = this.db.prepare(`
      INSERT INTO event_mappings (
        subscription_id,
        source_event_id,
        google_event_id,
        source_ical_uid,
        source_last_modified,
        google_etag,
        is_recurring_master,
        series_master_id,
        last_synced_at
      )
      VALUES (
        @subscriptionId,
        @sourceEventId,
        @googleEventId,
        @sourceIcalUid,
        @sourceLastModified,
        @googleEtag,
        @isRecurringMaster,
        @seriesMasterId,
        @lastSyncedAt
      )
      ON CONFLICT(subscription_id, source_event_id) DO UPDATE SET
        google_event_id = excluded.google_event_id,
        source_ical_uid = excluded.source_ical_uid,
        source_last_modified = excluded.source_last_modified,
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

  deleteMapping(subscriptionId: string, sourceEventId: string) {
    const stmt = this.db.prepare(
      `DELETE FROM event_mappings WHERE subscription_id = ? AND source_event_id = ?`,
    );
    stmt.run(subscriptionId, sourceEventId);
  }

  setState(subscriptionId: string, key: string, value: string) {
    const stmt = this.db.prepare(`
      INSERT INTO sync_state (subscription_id, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT(subscription_id, key) DO UPDATE SET value = excluded.value
    `);
    stmt.run(subscriptionId, key, value);
  }

  getState(subscriptionId: string, key: string): string | undefined {
    const stmt = this.db.prepare(`
      SELECT value
      FROM sync_state
      WHERE subscription_id = ? AND key = ?
    `);
    const row = stmt.get(subscriptionId, key) as { value: string } | undefined;
    return row?.value;
  }
}
