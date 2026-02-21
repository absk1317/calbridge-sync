import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

export type SourceMode = "microsoft" | "ics";

const SUBSCRIPTION_ID_REGEX = /^[a-zA-Z0-9._-]+$/;

const BaseConfigSchema = z.object({
  SOURCE_MODE: z.enum(["microsoft", "ics"]).default("microsoft"),
  DEFAULT_SUBSCRIPTION_ID: z.string().regex(SUBSCRIPTION_ID_REGEX).default("default"),
  SUBSCRIPTIONS_FILE: z.string().min(1).optional(),

  MICROSOFT_CLIENT_ID: z.string().min(1).optional(),
  MICROSOFT_TENANT_ID: z.string().min(1).default("common"),
  OUTLOOK_ICS_URL: z.string().url().optional(),

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

const SubscriptionFileEntrySchema = z.object({
  id: z.string().regex(SUBSCRIPTION_ID_REGEX),
  enabled: z.boolean().optional(),
  sourceMode: z.enum(["microsoft", "ics"]),
  googleTargetCalendarId: z.string().min(1).optional(),
  microsoftClientId: z.string().min(1).optional(),
  microsoftTenantId: z.string().min(1).optional(),
  outlookIcsUrl: z.string().url().optional(),
});

const SubscriptionFileSchema = z.union([
  z.array(SubscriptionFileEntrySchema),
  z.object({
    subscriptions: z.array(SubscriptionFileEntrySchema),
  }),
]);

export interface BaseConfig {
  googleClientId: string;
  googleClientSecret: string;
  tokenEncryptionKey: string;
  syncIntervalSeconds: number;
  syncLookbackDays: number;
  syncLookaheadDays: number;
  sqlitePath: string;
  logLevel: string;
  googleOAuthRedirectPort: number;

  defaultMicrosoftClientId?: string;
  defaultMicrosoftTenantId: string;
  defaultGoogleTargetCalendarId?: string;

  subscriptionsFilePath?: string;
  legacySourceMode: SourceMode;
  legacyOutlookIcsUrl?: string;
  legacySubscriptionId: string;
}

export interface SubscriptionConfig {
  id: string;
  enabled: boolean;
  sourceMode: SourceMode;
  googleTargetCalendarId: string;
  microsoftClientId?: string;
  microsoftTenantId?: string;
  outlookIcsUrl?: string;
}

export interface RuntimeConfig extends BaseConfig {
  subscriptions: SubscriptionConfig[];
}

type ParsedRawConfig = z.infer<typeof BaseConfigSchema>;
type SubscriptionFileEntry = z.infer<typeof SubscriptionFileEntrySchema>;

function parseRaw(): ParsedRawConfig {
  return BaseConfigSchema.parse({
    SOURCE_MODE: process.env.SOURCE_MODE,
    DEFAULT_SUBSCRIPTION_ID: process.env.DEFAULT_SUBSCRIPTION_ID,
    SUBSCRIPTIONS_FILE: process.env.SUBSCRIPTIONS_FILE,

    MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID,
    MICROSOFT_TENANT_ID: process.env.MICROSOFT_TENANT_ID,
    OUTLOOK_ICS_URL: process.env.OUTLOOK_ICS_URL,

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

function toBaseConfig(parsed: ParsedRawConfig): BaseConfig {
  const explicitSubscriptionsFile = parsed.SUBSCRIPTIONS_FILE
    ? path.resolve(parsed.SUBSCRIPTIONS_FILE)
    : undefined;

  const implicitSubscriptionsFile = path.resolve("subscriptions.json");
  const subscriptionsFilePath = explicitSubscriptionsFile
    ? explicitSubscriptionsFile
    : fs.existsSync(implicitSubscriptionsFile)
      ? implicitSubscriptionsFile
      : undefined;

  if (explicitSubscriptionsFile && !fs.existsSync(explicitSubscriptionsFile)) {
    throw new Error(`SUBSCRIPTIONS_FILE not found: ${explicitSubscriptionsFile}`);
  }

  return {
    googleClientId: parsed.GOOGLE_CLIENT_ID,
    googleClientSecret: parsed.GOOGLE_CLIENT_SECRET,
    tokenEncryptionKey: parsed.TOKEN_ENCRYPTION_KEY,
    syncIntervalSeconds: parsed.SYNC_INTERVAL_SECONDS,
    syncLookbackDays: parsed.SYNC_LOOKBACK_DAYS,
    syncLookaheadDays: parsed.SYNC_LOOKAHEAD_DAYS,
    sqlitePath: path.resolve(parsed.SQLITE_PATH),
    logLevel: parsed.LOG_LEVEL,
    googleOAuthRedirectPort: parsed.GOOGLE_OAUTH_REDIRECT_PORT,

    defaultMicrosoftClientId: parsed.MICROSOFT_CLIENT_ID,
    defaultMicrosoftTenantId: parsed.MICROSOFT_TENANT_ID,
    defaultGoogleTargetCalendarId: parsed.GOOGLE_TARGET_CALENDAR_ID,

    subscriptionsFilePath,
    legacySourceMode: parsed.SOURCE_MODE,
    legacyOutlookIcsUrl: parsed.OUTLOOK_ICS_URL,
    legacySubscriptionId: parsed.DEFAULT_SUBSCRIPTION_ID,
  };
}

function loadSubscriptionEntriesFromFile(subscriptionsFilePath: string): SubscriptionFileEntry[] {
  const rawContent = fs.readFileSync(subscriptionsFilePath, "utf8");
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawContent);
  } catch (error) {
    throw new Error(
      `Failed to parse subscriptions file JSON at ${subscriptionsFilePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = SubscriptionFileSchema.parse(parsedJson);
  return Array.isArray(parsed) ? parsed : parsed.subscriptions;
}

function loadLegacySingleSubscription(base: BaseConfig): SubscriptionFileEntry[] {
  return [
    {
      id: base.legacySubscriptionId,
      enabled: true,
      sourceMode: base.legacySourceMode,
      googleTargetCalendarId: base.defaultGoogleTargetCalendarId,
      microsoftClientId: base.defaultMicrosoftClientId,
      microsoftTenantId: base.defaultMicrosoftTenantId,
      outlookIcsUrl: base.legacyOutlookIcsUrl,
    },
  ];
}

function normalizeSubscription(base: BaseConfig, draft: SubscriptionFileEntry): SubscriptionConfig {
  const googleTargetCalendarId = draft.googleTargetCalendarId ?? base.defaultGoogleTargetCalendarId;
  if (!googleTargetCalendarId) {
    throw new Error(
      `Subscription '${draft.id}' is missing googleTargetCalendarId and GOOGLE_TARGET_CALENDAR_ID fallback is not set.`,
    );
  }

  if (draft.sourceMode === "microsoft") {
    const microsoftClientId = draft.microsoftClientId ?? base.defaultMicrosoftClientId;
    const microsoftTenantId = draft.microsoftTenantId ?? base.defaultMicrosoftTenantId;

    if (!microsoftClientId) {
      throw new Error(
        `Subscription '${draft.id}' uses microsoft source but microsoftClientId and MICROSOFT_CLIENT_ID are both missing.`,
      );
    }

    return {
      id: draft.id,
      enabled: draft.enabled ?? true,
      sourceMode: "microsoft",
      googleTargetCalendarId,
      microsoftClientId,
      microsoftTenantId,
    };
  }

  const outlookIcsUrl = draft.outlookIcsUrl ?? base.legacyOutlookIcsUrl;
  if (!outlookIcsUrl) {
    throw new Error(
      `Subscription '${draft.id}' uses ics source but outlookIcsUrl and OUTLOOK_ICS_URL are both missing.`,
    );
  }

  return {
    id: draft.id,
    enabled: draft.enabled ?? true,
    sourceMode: "ics",
    googleTargetCalendarId,
    outlookIcsUrl,
  };
}

function ensureValidSubscriptions(subscriptions: SubscriptionConfig[]) {
  if (subscriptions.length === 0) {
    throw new Error("No subscriptions configured.");
  }

  const seen = new Set<string>();
  for (const subscription of subscriptions) {
    if (seen.has(subscription.id)) {
      throw new Error(`Duplicate subscription id '${subscription.id}'.`);
    }
    seen.add(subscription.id);
  }

  if (!subscriptions.some((subscription) => subscription.enabled)) {
    throw new Error("All subscriptions are disabled. Enable at least one subscription.");
  }
}

export function loadBaseConfig(): BaseConfig {
  const parsed = parseRaw();
  return toBaseConfig(parsed);
}

export function loadRuntimeConfig(): RuntimeConfig {
  const base = loadBaseConfig();

  const drafts = base.subscriptionsFilePath
    ? loadSubscriptionEntriesFromFile(base.subscriptionsFilePath)
    : loadLegacySingleSubscription(base);

  const subscriptions = drafts.map((draft) => normalizeSubscription(base, draft));
  ensureValidSubscriptions(subscriptions);

  return {
    ...base,
    subscriptions,
  };
}
