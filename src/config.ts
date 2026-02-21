import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const BaseConfigSchema = z.object({
  MICROSOFT_CLIENT_ID: z.string().min(1),
  MICROSOFT_TENANT_ID: z.string().min(1).default("common"),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_TARGET_CALENDAR_ID: z.string().min(1).optional(),
  TOKEN_ENCRYPTION_KEY: z.string().min(16),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().positive().default(300),
  SYNC_LOOKBACK_DAYS: z.coerce.number().int().nonnegative().default(7),
  SYNC_LOOKAHEAD_DAYS: z.coerce.number().int().nonnegative().default(15),
  SQLITE_PATH: z.string().min(1).default("./data/sync.db"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  GOOGLE_OAUTH_REDIRECT_PORT: z.coerce.number().int().positive().default(53682),
});

export interface BaseConfig {
  microsoftClientId: string;
  microsoftTenantId: string;
  googleClientId: string;
  googleClientSecret: string;
  tokenEncryptionKey: string;
  syncIntervalSeconds: number;
  syncLookbackDays: number;
  syncLookaheadDays: number;
  sqlitePath: string;
  logLevel: string;
  googleOAuthRedirectPort: number;
}

export interface AppConfig extends BaseConfig {
  googleTargetCalendarId: string;
}

function parseRaw() {
  return BaseConfigSchema.parse({
    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_TARGET_CALENDAR_ID: process.env.GOOGLE_TARGET_CALENDAR_ID,
    TOKEN_ENCRYPTION_KEY: process.env.TOKEN_ENCRYPTION_KEY,
    SYNC_INTERVAL_SECONDS: process.env.SYNC_INTERVAL_SECONDS,
    SYNC_LOOKBACK_DAYS: process.env.SYNC_LOOKBACK_DAYS,
    SYNC_LOOKAHEAD_DAYS: process.env.SYNC_LOOKAHEAD_DAYS,
    SQLITE_PATH: process.env.SQLITE_PATH,
    LOG_LEVEL: process.env.LOG_LEVEL,
    GOOGLE_OAUTH_REDIRECT_PORT: process.env.GOOGLE_OAUTH_REDIRECT_PORT,
  });
}

export function loadBaseConfig(): BaseConfig {
  const parsed = parseRaw();
  return {
    microsoftClientId: parsed.MICROSOFT_CLIENT_ID,
    microsoftTenantId: parsed.MICROSOFT_TENANT_ID,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
    syncIntervalSeconds: parsed.SYNC_INTERVAL_SECONDS,
    syncLookbackDays: parsed.SYNC_LOOKBACK_DAYS,
    syncLookaheadDays: parsed.SYNC_LOOKAHEAD_DAYS,
    sqlitePath: path.resolve(parsed.SQLITE_PATH),
    logLevel: parsed.LOG_LEVEL,
    googleOAuthRedirectPort: parsed.GOOGLE_OAUTH_REDIRECT_PORT,
  };
}

export function loadAppConfig(): AppConfig {
  const parsed = parseRaw();
  if (!parsed.GOOGLE_TARGET_CALENDAR_ID) {
    throw new Error("GOOGLE_TARGET_CALENDAR_ID is required for sync commands");
  }

  return {
    microsoftClientId: parsed.MICROSOFT_CLIENT_ID,
    microsoftTenantId: parsed.MICROSOFT_TENANT_ID,
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    googleTargetCalendarId: parsed.GOOGLE_TARGET_CALENDAR_ID,
    tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
    syncIntervalSeconds: parsed.SYNC_INTERVAL_SECONDS,
    syncLookbackDays: parsed.SYNC_LOOKBACK_DAYS,
    syncLookaheadDays: parsed.SYNC_LOOKAHEAD_DAYS,
    sqlitePath: path.resolve(parsed.SQLITE_PATH),
    logLevel: parsed.LOG_LEVEL,
    googleOAuthRedirectPort: parsed.GOOGLE_OAUTH_REDIRECT_PORT,
  };
}
