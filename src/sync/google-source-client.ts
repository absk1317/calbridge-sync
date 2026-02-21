import type { GoogleCalendarClient } from "../clients/google-calendar.js";
import { normalizeGoogleCalendarEvent } from "./mapper.js";
import type { SourceClient, SourceEventBatch } from "./source-client.js";
import type { SourceEvent } from "./types.js";

export class GoogleSourceClient implements SourceClient {
  readonly name = "google";

  constructor(
    private readonly googleClient: GoogleCalendarClient,
    private readonly sourceCalendarId: string,
  ) {}

  async listEvents(startIso: string, endIso: string): Promise<SourceEventBatch> {
    const googleEvents = await this.googleClient.listCalendarView(this.sourceCalendarId, startIso, endIso);
    const events = googleEvents
      .map(normalizeGoogleCalendarEvent)
      .filter((event): event is SourceEvent => Boolean(event));

    return {
      fetchedCount: googleEvents.length,
      events,
    };
  }

  async healthCheck(): Promise<void> {
    await this.googleClient.healthCheck(this.sourceCalendarId);
  }
}
