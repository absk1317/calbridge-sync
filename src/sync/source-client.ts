import type { SourceEvent } from "./types.js";

export interface SourceEventBatch {
  fetchedCount: number;
  events: SourceEvent[];
}

export interface SourceClient {
  listEvents(startIso: string, endIso: string): Promise<SourceEventBatch>;
  healthCheck(): Promise<void>;
  readonly name: string;
}
