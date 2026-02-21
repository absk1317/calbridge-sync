import type pino from "pino";
import type { RuntimeConfig, SubscriptionConfig } from "../config.js";
import type { DbClient, EventMapping } from "../db.js";
import { HttpError } from "../http.js";
import type { GoogleCalendarClient } from "../clients/google-calendar.js";
import { findStaleOutlookIds } from "./reconcile.js";
import { toGoogleEventPayload } from "./mapper.js";
import type { SourceClient } from "./source-client.js";
import type { SourceEvent, SyncCycleResult, SyncMetrics } from "./types.js";

export class SyncService {
  constructor(
    private readonly config: RuntimeConfig,
    private readonly subscription: SubscriptionConfig,
    private readonly db: DbClient,
    private readonly sourceClient: SourceClient,
    private readonly googleClient: GoogleCalendarClient,
    private readonly logger: pino.Logger,
  ) {}

  async runCycle(now = new Date()): Promise<SyncCycleResult> {
    const { startIso, endIso } = this.computeWindow(now);
    const metrics: SyncMetrics = {
      fetched: 0,
      considered: 0,
      created: 0,
      updated: 0,
      deleted: 0,
    };

    try {
      const sourceBatch = await this.sourceClient.listEvents(startIso, endIso);
      metrics.fetched = sourceBatch.fetchedCount;
      const sourceEvents = sourceBatch.events;
      metrics.considered = sourceEvents.length;

      const activeEventsById = new Map<string, SourceEvent>();
      for (const event of sourceEvents) {
        if (!event.isCancelled) {
          activeEventsById.set(event.id, event);
        }
      }

      const mappings = this.db.listMappings(this.subscription.id);
      const mappingBySourceEventId = new Map<string, EventMapping>(
        mappings.map((mapping) => [mapping.sourceEventId, mapping]),
      );

      for (const sourceEvent of activeEventsById.values()) {
        const payload = toGoogleEventPayload(sourceEvent, this.subscription.id);
        const existingMapping = mappingBySourceEventId.get(sourceEvent.id);

        if (!existingMapping) {
          const created = await this.googleClient.createEvent(
            this.subscription.googleTargetCalendarId,
            payload,
          );
          this.saveMapping(sourceEvent, created.id, created.etag ?? null);
          metrics.created += 1;
          continue;
        }

        try {
          const updated = await this.googleClient.updateEvent(
            this.subscription.googleTargetCalendarId,
            existingMapping.googleEventId,
            payload,
          );
          this.saveMapping(sourceEvent, existingMapping.googleEventId, updated.etag ?? null);
          metrics.updated += 1;
        } catch (error) {
          if (error instanceof HttpError && error.status === 404) {
            const recreated = await this.googleClient.createEvent(
              this.subscription.googleTargetCalendarId,
              payload,
            );
            this.saveMapping(sourceEvent, recreated.id, recreated.etag ?? null);
            metrics.created += 1;
            continue;
          }
          throw error;
        }
      }

      const staleSourceIds = findStaleOutlookIds(
        mappingBySourceEventId.keys(),
        new Set(activeEventsById.keys()),
      );

      for (const staleSourceId of staleSourceIds) {
        const staleMapping = mappingBySourceEventId.get(staleSourceId);
        if (!staleMapping) {
          continue;
        }

        await this.googleClient.deleteEvent(
          this.subscription.googleTargetCalendarId,
          staleMapping.googleEventId,
        );
        this.db.deleteMapping(this.subscription.id, staleSourceId);
        metrics.deleted += 1;
      }

      this.db.setState(this.subscription.id, "last_successful_sync_ts", new Date().toISOString());
      this.db.setState(this.subscription.id, "last_run_status", "success");

      return {
        subscriptionId: this.subscription.id,
        sourceMode: this.subscription.sourceMode,
        targetCalendarId: this.subscription.googleTargetCalendarId,
        windowStartIso: startIso,
        windowEndIso: endIso,
        metrics,
      };
    } catch (error) {
      this.db.setState(
        this.subscription.id,
        "last_run_status",
        `failed:${new Date().toISOString()}`,
      );
      this.logger.error(
        {
          subscriptionId: this.subscription.id,
          sourceMode: this.subscription.sourceMode,
          err: error,
        },
        "Sync cycle failed",
      );
      throw error;
    }
  }

  private computeWindow(now: Date): { startIso: string; endIso: string } {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - this.config.syncLookbackDays);

    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() + this.config.syncLookaheadDays);

    return {
      startIso: start.toISOString(),
      endIso: end.toISOString(),
    };
  }

  private saveMapping(source: SourceEvent, googleEventId: string, googleEtag: string | null) {
    this.db.upsertMapping({
      subscriptionId: this.subscription.id,
      sourceEventId: source.id,
      googleEventId,
      sourceIcalUid: source.iCalUid,
      sourceLastModified: source.lastModifiedDateTime,
      googleEtag,
      isRecurringMaster: source.isRecurringMaster,
      seriesMasterId: source.seriesMasterId,
      lastSyncedAt: new Date().toISOString(),
    });
  }
}
