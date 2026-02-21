import type { IcsFeedClient } from "../clients/ics-feed.js";
import type { SourceClient, SourceEventBatch } from "./source-client.js";

export class IcsSourceClient implements SourceClient {
  readonly name = "ics";

  constructor(private readonly icsClient: IcsFeedClient) {}

  async listEvents(startIso: string, endIso: string): Promise<SourceEventBatch> {
    return this.icsClient.listEvents(startIso, endIso);
  }

  async healthCheck(): Promise<void> {
    await this.icsClient.healthCheck();
  }
}
