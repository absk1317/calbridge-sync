import type { GoogleEventInput } from "../clients/google-calendar.js";

export interface EventTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface SourceEvent {
  id: string;
  iCalUid: string | null;
  title: string;
  description: string;
  location: string;
  start: EventTime;
  end: EventTime;
  isAllDay: boolean;
  isCancelled: boolean;
  lastModifiedDateTime: string | null;
  reminderMinutesBeforeStart: number | null;
  isRecurringMaster: boolean;
  seriesMasterId: string | null;
}

export interface SyncMetrics {
  fetched: number;
  considered: number;
  created: number;
  updated: number;
  deleted: number;
}

export interface SyncCycleResult {
  subscriptionId: string;
  sourceMode: "microsoft" | "ics" | "google";
  targetCalendarId: string;
  windowStartIso: string;
  windowEndIso: string;
  metrics: SyncMetrics;
}

export interface ManagedGoogleEventPayload extends GoogleEventInput {}
