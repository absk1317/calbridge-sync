#!/usr/bin/env node

import { Command } from "commander";
import type pino from "pino";
import { authenticateGoogleOAuth, getGoogleAccessToken } from "./auth/google.js";
import {
  authenticateMicrosoftDeviceCode,
  getMicrosoftAccessToken,
  type MicrosoftAuthConfig,
} from "./auth/microsoft.js";
import { TokenStore } from "./auth/token-store.js";
import { GoogleCalendarClient } from "./clients/google-calendar.js";
import { IcsFeedClient } from "./clients/ics-feed.js";
import { MicrosoftGraphClient } from "./clients/microsoft-graph.js";
import {
  loadBaseConfig,
  loadRuntimeConfig,
  type BaseConfig,
  type RuntimeConfig,
  type SubscriptionConfig,
} from "./config.js";
import { DbClient } from "./db.js";
import { HttpError } from "./http.js";
import { createLogger } from "./logger.js";
import { GoogleSourceClient } from "./sync/google-source-client.js";
import { IcsSourceClient } from "./sync/ics-source-client.js";
import { MicrosoftSourceClient } from "./sync/microsoft-source-client.js";
import type { SourceClient } from "./sync/source-client.js";
import { SyncService } from "./sync/service.js";

const GOOGLE_TARGET_TOKEN_KEY = "default";

interface BaseRuntime {
  config: BaseConfig;
  db: DbClient;
  logger: pino.Logger;
  tokenStore: TokenStore;
}

interface SubscriptionRuntime {
  subscription: SubscriptionConfig;
  sourceClient: SourceClient;
  syncService: SyncService;
}

interface Runtime {
  config: RuntimeConfig;
  db: DbClient;
  logger: pino.Logger;
  tokenStore: TokenStore;
  googleClient: GoogleCalendarClient;
  subscriptions: SubscriptionRuntime[];
}

function toGoogleAuthConfig(config: BaseConfig) {
  return {
    googleClientId: config.googleClientId,
    googleClientSecret: config.googleClientSecret,
    googleOAuthRedirectPort: config.googleOAuthRedirectPort,
  };
}

function toMicrosoftAuthConfig(subscription: SubscriptionConfig): MicrosoftAuthConfig {
  if (!subscription.microsoftClientId || !subscription.microsoftTenantId) {
    throw new Error(`Subscription '${subscription.id}' is missing Microsoft auth configuration.`);
  }

  return {
    microsoftClientId: subscription.microsoftClientId,
    microsoftTenantId: subscription.microsoftTenantId,
  };
}

async function withBaseRuntime<T>(fn: (runtime: BaseRuntime) => Promise<T>): Promise<T> {
  const config = loadBaseConfig();
  const logger = createLogger(config.logLevel);
  const db = new DbClient(config.sqlitePath);
  const tokenStore = new TokenStore(db, config.tokenEncryptionKey, logger);

  try {
    return await fn({ config, db, logger, tokenStore });
  } finally {
    db.close();
  }
}

async function withRuntime<T>(fn: (runtime: Runtime) => Promise<T>): Promise<T> {
  const config = loadRuntimeConfig();
  const logger = createLogger(config.logLevel);
  const db = new DbClient(config.sqlitePath);
  const tokenStore = new TokenStore(db, config.tokenEncryptionKey, logger);

  const googleClient = new GoogleCalendarClient(
    () => getGoogleAccessToken(toGoogleAuthConfig(config), tokenStore, GOOGLE_TARGET_TOKEN_KEY),
    logger,
  );

  const subscriptions: SubscriptionRuntime[] = config.subscriptions
    .filter((subscription) => subscription.enabled)
    .map((subscription) => {
      let sourceClient: SourceClient;

      if (subscription.sourceMode === "microsoft") {
        const graphClient = new MicrosoftGraphClient(
          () =>
            getMicrosoftAccessToken(
              toMicrosoftAuthConfig(subscription),
              tokenStore,
              subscription.id,
            ),
          logger,
        );
        sourceClient = new MicrosoftSourceClient(graphClient);
      } else if (subscription.sourceMode === "ics") {
        if (!subscription.outlookIcsUrl) {
          throw new Error(`Subscription '${subscription.id}' missing OUTLOOK_ICS_URL.`);
        }
        sourceClient = new IcsSourceClient(new IcsFeedClient(subscription.outlookIcsUrl, logger));
      } else {
        if (!subscription.googleSourceCalendarId) {
          throw new Error(`Subscription '${subscription.id}' missing googleSourceCalendarId.`);
        }
        const googleSourceTokenKey = subscription.googleSourceTokenKey ?? GOOGLE_TARGET_TOKEN_KEY;
        const googleSourceClient = new GoogleCalendarClient(
          () => getGoogleAccessToken(toGoogleAuthConfig(config), tokenStore, googleSourceTokenKey),
          logger,
        );
        sourceClient = new GoogleSourceClient(googleSourceClient, subscription.googleSourceCalendarId);
      }

      const syncService = new SyncService(config, subscription, db, sourceClient, googleClient, logger);

      return {
        subscription,
        sourceClient,
        syncService,
      };
    });

  try {
    return await fn({
      config,
      db,
      logger,
      tokenStore,
      googleClient,
      subscriptions,
    });
  } finally {
    db.close();
  }
}

async function runOnceForAllSubscriptions(runtime: Runtime) {
  const successes: Array<unknown> = [];
  const failures: Array<{ subscriptionId: string; sourceMode: string; error: string }> = [];

  for (const subscriptionRuntime of runtime.subscriptions) {
    const { subscription, syncService } = subscriptionRuntime;
    try {
      const result = await syncService.runCycle();
      successes.push(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        subscriptionId: subscription.id,
        sourceMode: subscription.sourceMode,
        error: message,
      });
    }
  }

  return {
    ranAt: new Date().toISOString(),
    subscriptionCount: runtime.subscriptions.length,
    successCount: successes.length,
    failureCount: failures.length,
    successes,
    failures,
  };
}

function chooseMicrosoftSubscription(
  subscriptions: SubscriptionConfig[],
  requestedId: string | undefined,
): SubscriptionConfig {
  const microsoftSubs = subscriptions.filter((subscription) => subscription.sourceMode === "microsoft");

  if (microsoftSubs.length === 0) {
    throw new Error("No Microsoft subscriptions are configured.");
  }

  if (requestedId) {
    const match = microsoftSubs.find((subscription) => subscription.id === requestedId);
    if (!match) {
      throw new Error(
        `Microsoft subscription '${requestedId}' not found. Available: ${microsoftSubs.map((s) => s.id).join(", ")}`,
      );
    }
    return match;
  }

  if (microsoftSubs.length === 1) {
    return microsoftSubs[0];
  }

  throw new Error(
    `Multiple Microsoft subscriptions found (${microsoftSubs
      .map((s) => s.id)
      .join(", ")}). Use --subscription <id>.`,
  );
}

function parseCsvList(values: string[]): string[] {
  return values
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

const program = new Command();
program.name("sync-daemon").description("Calendar source to Google calendar sync daemon").version("0.2.0");

program
  .command("auth:microsoft")
  .description("Authenticate Microsoft account via device code flow")
  .option("-s, --subscription <id>", "subscription id (required when multiple Microsoft subscriptions exist)")
  .action(async (options: { subscription?: string }) => {
    await withRuntime(async ({ config, tokenStore, logger }) => {
      const subscription = chooseMicrosoftSubscription(config.subscriptions, options.subscription);
      await authenticateMicrosoftDeviceCode(
        toMicrosoftAuthConfig(subscription),
        tokenStore,
        logger,
        subscription.id,
      );
    });
  });

program
  .command("auth:google")
  .description("Authenticate Google account via OAuth redirect")
  .option(
    "-k, --token-key <key>",
    "token key (use distinct keys for multiple Google accounts)",
    GOOGLE_TARGET_TOKEN_KEY,
  )
  .action(async (options: { tokenKey: string }) => {
    await withBaseRuntime(async ({ config, tokenStore, logger }) => {
      await authenticateGoogleOAuth(toGoogleAuthConfig(config), tokenStore, logger, options.tokenKey);
    });
  });

program
  .command("once")
  .description("Run exactly one sync cycle for all enabled subscriptions")
  .action(async () => {
    await withRuntime(async (runtime) => {
      const summary = await runOnceForAllSubscriptions(runtime);
      console.log(JSON.stringify(summary, null, 2));

      if (summary.failureCount > 0) {
        throw new Error(`Sync failed for ${summary.failureCount} subscription(s).`);
      }
    });
  });

program
  .command("health")
  .description("Verify database and API access with current credentials")
  .action(async () => {
    await withRuntime(async ({ subscriptions, googleClient, tokenStore }) => {
      if (!tokenStore.get("google", GOOGLE_TARGET_TOKEN_KEY)) {
        throw new Error("Google target token not found. Run auth:google first.");
      }

      const uniqueTargetCalendars = new Set<string>();
      for (const subscriptionRuntime of subscriptions) {
        uniqueTargetCalendars.add(subscriptionRuntime.subscription.googleTargetCalendarId);
      }

      for (const calendarId of uniqueTargetCalendars) {
        await googleClient.healthCheck(calendarId);
      }

      const subscriptionStatuses: Array<Record<string, unknown>> = [];
      for (const subscriptionRuntime of subscriptions) {
        const { subscription, sourceClient } = subscriptionRuntime;

        if (subscription.sourceMode === "microsoft") {
          if (!tokenStore.get("microsoft", subscription.id)) {
            throw new Error(
              `Microsoft token for subscription '${subscription.id}' not found. Run auth:microsoft --subscription ${subscription.id} first.`,
            );
          }
        }
        if (subscription.sourceMode === "google") {
          const sourceTokenKey = subscription.googleSourceTokenKey ?? GOOGLE_TARGET_TOKEN_KEY;
          if (!tokenStore.get("google", sourceTokenKey)) {
            throw new Error(
              sourceTokenKey === GOOGLE_TARGET_TOKEN_KEY
                ? "Google source token not found. Run auth:google first."
                : `Google source token '${sourceTokenKey}' not found. Run auth:google --token-key ${sourceTokenKey} first.`,
            );
          }
        }

        await sourceClient.healthCheck();
        subscriptionStatuses.push({
          id: subscription.id,
          enabled: subscription.enabled,
          sourceMode: subscription.sourceMode,
          sourceClient: sourceClient.name,
          targetCalendarId: subscription.googleTargetCalendarId,
          status: "ok",
        });
      }

      console.log(
        JSON.stringify(
          {
            database: "ok",
            google: "ok",
            subscriptions: subscriptionStatuses,
          },
          null,
          2,
        ),
      );
    });
  });

program
  .command("start")
  .description("Start long-running daemon sync loop for all enabled subscriptions")
  .action(async () => {
    await withRuntime(async (runtime) => {
      let shuttingDown = false;
      let cycleRunning = false;

      const runAllCycles = async () => {
        if (cycleRunning) {
          runtime.logger.warn("Previous cycle still running; skipping this interval");
          return;
        }

        cycleRunning = true;
        try {
          const summary = await runOnceForAllSubscriptions(runtime);
          runtime.logger.info(
            {
              subscriptionCount: summary.subscriptionCount,
              successCount: summary.successCount,
              failureCount: summary.failureCount,
            },
            "Sync cycle batch completed",
          );

          if (summary.failureCount > 0) {
            runtime.logger.error({ failures: summary.failures }, "One or more subscriptions failed");
          }
        } catch (error) {
          runtime.logger.error({ err: error }, "Unexpected sync batch failure");
        } finally {
          cycleRunning = false;
        }
      };

      await runAllCycles();

      const timer = setInterval(() => {
        void runAllCycles();
      }, runtime.config.syncIntervalSeconds * 1000);

      await new Promise<void>((resolve) => {
        const onSignal = () => {
          if (shuttingDown) {
            return;
          }
          shuttingDown = true;
          clearInterval(timer);
          runtime.logger.info("Shutdown signal received");

          const waitForCycle = () => {
            if (!cycleRunning) {
              process.off("SIGINT", onSignal);
              process.off("SIGTERM", onSignal);
              resolve();
              return;
            }
            setTimeout(waitForCycle, 250);
          };

          waitForCycle();
        };

        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);
      });
    });
  });

program
  .command("cleanup:managed")
  .description("Delete app-managed events from target calendar(s) and reset local sync state")
  .option(
    "-s, --subscription <ids...>",
    "subscription id(s); defaults to all enabled subscriptions",
  )
  .option("-c, --calendar <ids...>", "target calendar id(s); defaults from selected subscriptions")
  .option("--dry-run", "show what would be deleted without mutating data", false)
  .option("--yes", "confirm destructive cleanup", false)
  .action(
    async (options: {
      subscription?: string[];
      calendar?: string[];
      dryRun: boolean;
      yes: boolean;
    }) => {
      await withRuntime(async ({ config, db, googleClient, subscriptions, tokenStore }) => {
        if (!tokenStore.get("google", GOOGLE_TARGET_TOKEN_KEY)) {
          throw new Error("Google target token not found. Run auth:google first.");
        }

        const requestedSubscriptionIds = parseCsvList(options.subscription ?? []);
        const selectedSubscriptions =
          requestedSubscriptionIds.length > 0
            ? subscriptions.filter((subscriptionRuntime) =>
                requestedSubscriptionIds.includes(subscriptionRuntime.subscription.id),
              )
            : subscriptions;

        if (selectedSubscriptions.length === 0) {
          throw new Error("No matching subscriptions selected for cleanup.");
        }

        if (requestedSubscriptionIds.length > 0) {
          const selectedIds = new Set(selectedSubscriptions.map((s) => s.subscription.id));
          const missing = requestedSubscriptionIds.filter((id) => !selectedIds.has(id));
          if (missing.length > 0) {
            throw new Error(`Unknown subscription id(s): ${missing.join(", ")}`);
          }
        }

        const requestedCalendars = parseCsvList(options.calendar ?? []);
        const derivedCalendars = selectedSubscriptions.map(
          (subscriptionRuntime) => subscriptionRuntime.subscription.googleTargetCalendarId,
        );
        const targetCalendars = Array.from(
          new Set(requestedCalendars.length > 0 ? requestedCalendars : derivedCalendars),
        );

        if (targetCalendars.length === 0) {
          throw new Error("No target calendars resolved for cleanup.");
        }

        const eventsToDeleteByCalendar = new Map<string, string[]>();
        let totalEventsToDelete = 0;
        for (const calendarId of targetCalendars) {
          const managedEvents = await googleClient.listEventsByPrivateExtendedProperties(calendarId, {
            app: "outlook-google-sync",
          });
          const ids = managedEvents.map((event) => event.id).filter(Boolean);
          eventsToDeleteByCalendar.set(calendarId, ids);
          totalEventsToDelete += ids.length;
        }

        const affectedSubscriptions = config.subscriptions.filter((subscription) =>
          targetCalendars.includes(subscription.googleTargetCalendarId),
        );

        const summary = {
          dryRun: options.dryRun,
          selectedSubscriptionIds: selectedSubscriptions.map((s) => s.subscription.id),
          targetCalendars,
          affectedSubscriptionIds: affectedSubscriptions.map((s) => s.id),
          eventCountsByCalendar: Object.fromEntries(
            Array.from(eventsToDeleteByCalendar.entries()).map(([calendarId, ids]) => [
              calendarId,
              ids.length,
            ]),
          ),
          totalEventsToDelete,
        };

        if (options.dryRun) {
          console.log(JSON.stringify(summary, null, 2));
          return;
        }

        if (!options.yes) {
          throw new Error(
            "Refusing destructive cleanup without --yes. Re-run with --dry-run to preview or --yes to execute.",
          );
        }

        let deletedEventCount = 0;
        for (const [calendarId, eventIds] of eventsToDeleteByCalendar.entries()) {
          for (const eventId of eventIds) {
            await googleClient.deleteEvent(calendarId, eventId);
            deletedEventCount += 1;
          }
        }

        const mappingRowsDeletedBySubscription: Record<string, number> = {};
        const stateRowsDeletedBySubscription: Record<string, number> = {};
        for (const subscription of affectedSubscriptions) {
          mappingRowsDeletedBySubscription[subscription.id] = db.deleteAllMappings(subscription.id);
          stateRowsDeletedBySubscription[subscription.id] = db.deleteAllState(subscription.id);
        }

        console.log(
          JSON.stringify(
            {
              ...summary,
              dryRun: false,
              deletedEventCount,
              mappingRowsDeletedBySubscription,
              stateRowsDeletedBySubscription,
            },
            null,
            2,
          ),
        );
      });
    },
  );

program.parseAsync(process.argv).catch((error) => {
  if (error instanceof HttpError) {
    console.error(`HTTP ${error.status}: ${error.message}`);
    console.error(
      typeof error.body === "string" ? error.body : JSON.stringify(error.body, null, 2),
    );
    process.exitCode = 1;
    return;
  }

  const message = error instanceof Error ? error.message : String(error);
  console.error(message);

  if (
    typeof message === "string" &&
    message.includes("Microsoft token not found") &&
    process.env.OUTLOOK_ICS_URL
  ) {
    console.error(
      "Hint: OUTLOOK_ICS_URL is set. Configure subscription sourceMode=ics if this source should avoid Microsoft auth.",
    );
  }

  process.exitCode = 1;
});
