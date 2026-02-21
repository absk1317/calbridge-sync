import type { MicrosoftGraphClient } from "../clients/microsoft-graph.js";
import { normalizeOutlookEvent } from "./mapper.js";
import type { SourceClient, SourceEventBatch } from "./source-client.js";
import type { SourceEvent } from "./types.js";

export class MicrosoftSourceClient implements SourceClient {
  readonly name = "microsoft";

  constructor(private readonly graphClient: MicrosoftGraphClient) {}

  async listEvents(startIso: string, endIso: string): Promise<SourceEventBatch> {
    const graphEvents = await this.graphClient.listCalendarView(startIso, endIso);
    const events = graphEvents
      .map(normalizeOutlookEvent)
      .filter((event): event is SourceEvent => Boolean(event));

    return {
      fetchedCount: graphEvents.length,
      events,
    };
  }

  async healthCheck(): Promise<void> {
    await this.graphClient.healthCheck();
  }
}
