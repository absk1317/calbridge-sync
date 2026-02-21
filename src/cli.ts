#!/usr/bin/env node

import { Command } from "commander";
import type pino from "pino";
import { authenticateGoogleOAuth, getGoogleAccessToken } from "./auth/google.js";
import { authenticateMicrosoftDeviceCode, getMicrosoftAccessToken } from "./auth/microsoft.js";
import { TokenStore } from "./auth/token-store.js";
import { GoogleCalendarClient } from "./clients/google-calendar.js";
import { IcsFeedClient } from "./clients/ics-feed.js";
import { MicrosoftGraphClient } from "./clients/microsoft-graph.js";
import type { AppConfig, BaseConfig } from "./config.js";
import { loadAppConfig, loadBaseConfig } from "./config.js";
import { DbClient } from "./db.js";
import { HttpError } from "./http.js";
import { createLogger } from "./logger.js";
import { IcsSourceClient } from "./sync/ics-source-client.js";
import { MicrosoftSourceClient } from "./sync/microsoft-source-client.js";
import type { SourceClient } from "./sync/source-client.js";
import { SyncService } from "./sync/service.js";

interface BaseRuntime {
  config: BaseConfig;
  db: DbClient;
  logger: pino.Logger;
  tokenStore: TokenStore;
}

interface SyncRuntime {
  config: AppConfig;
  db: DbClient;
  logger: pino.Logger;
  tokenStore: TokenStore;
  sourceClient: SourceClient;
  googleClient: GoogleCalendarClient;
  syncService: SyncService;
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

async function withSyncRuntime<T>(fn: (runtime: SyncRuntime) => Promise<T>): Promise<T> {
  const config = loadAppConfig();
  const logger = createLogger(config.logLevel);
  const db = new DbClient(config.sqlitePath);
  const tokenStore = new TokenStore(db, config.tokenEncryptionKey, logger);

  const googleClient = new GoogleCalendarClient(() => getGoogleAccessToken(config, tokenStore), logger);

  let sourceClient: SourceClient;
  if (config.sourceMode === "microsoft") {
    const graphClient = new MicrosoftGraphClient(
      () => getMicrosoftAccessToken(config, tokenStore),
      logger,
    );
    sourceClient = new MicrosoftSourceClient(graphClient);
  } else {
    if (!config.outlookIcsUrl) {
      throw new Error("OUTLOOK_ICS_URL is required when SOURCE_MODE=ics");
    }
    sourceClient = new IcsSourceClient(new IcsFeedClient(config.outlookIcsUrl, logger));
  }

  const syncService = new SyncService(config, db, sourceClient, googleClient, logger);

  try {
    return await fn({
      config,
      db,
      logger,
      tokenStore,
      sourceClient,
      googleClient,
      syncService,
    });
  } finally {
    db.close();
  }
}

const program = new Command();
program.name("sync-daemon").description("Outlook to Google calendar sync daemon").version("0.1.0");

program
  .command("auth:microsoft")
  .description("Authenticate Microsoft account via device code flow")
  .action(async () => {
    await withBaseRuntime(async ({ config, tokenStore, logger }) => {
      await authenticateMicrosoftDeviceCode(config, tokenStore, logger);
    });
  });

program
  .command("auth:google")
  .description("Authenticate Google account via OAuth redirect")
  .action(async () => {
    await withBaseRuntime(async ({ config, tokenStore, logger }) => {
      await authenticateGoogleOAuth(config, tokenStore, logger);
    });
  });

program
  .command("once")
  .description("Run exactly one sync cycle")
  .action(async () => {
    await withSyncRuntime(async ({ syncService }) => {
      const result = await syncService.runCycle();
      console.log(JSON.stringify(result, null, 2));
    });
  });

program
  .command("health")
  .description("Verify database and API access with current credentials")
  .action(async () => {
    await withSyncRuntime(async ({ config, sourceClient, googleClient, tokenStore }) => {
      const status = {
        database: "ok",
        source: sourceClient.name,
        microsoft: config.sourceMode === "microsoft" ? "ok" : "skipped",
        google: "ok",
        targetCalendarId: config.googleTargetCalendarId,
      };

      if (config.sourceMode === "microsoft") {
        tokenStore.get("microsoft");
      }
      tokenStore.get("google");

      await sourceClient.healthCheck();
      await googleClient.healthCheck(config.googleTargetCalendarId);
      console.log(JSON.stringify(status, null, 2));
    });
  });

program
  .command("start")
  .description("Start long-running daemon sync loop")
  .action(async () => {
    await withSyncRuntime(async ({ config, syncService, logger }) => {
      let shuttingDown = false;
      let cycleRunning = false;

      const runCycle = async () => {
        if (cycleRunning) {
          logger.warn("Previous cycle still running; skipping this interval");
          return;
        }

        cycleRunning = true;
        try {
          const result = await syncService.runCycle();
          logger.info({ metrics: result.metrics }, "Sync cycle completed");
        } catch (error) {
          logger.error({ err: error }, "Sync cycle failed");
        } finally {
          cycleRunning = false;
        }
      };

      await runCycle();

      const timer = setInterval(() => {
        void runCycle();
      }, config.syncIntervalSeconds * 1000);

      await new Promise<void>((resolve) => {
        const onSignal = () => {
          if (shuttingDown) {
            return;
          }
          shuttingDown = true;
          clearInterval(timer);
          logger.info("Shutdown signal received");

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
      "Hint: OUTLOOK_ICS_URL is set. If you want to use ICS mode, set SOURCE_MODE=ics in .env and rerun.",
    );
  }

  process.exitCode = 1;
});
