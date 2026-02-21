import type { GoogleEventInput } from "../clients/google-calendar.js";
import type { GraphDateTimeTimeZone, GraphEvent } from "../clients/microsoft-graph.js";
import type { SourceEvent } from "./types.js";

const APP_MARKER = "outlook-google-sync";

function stripHtml(content: string): string {
  return content
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDateTime(raw: GraphDateTimeTimeZone): { dateTime: string; timeZone: string } {
  const input = raw.dateTime;
  const hasZone = /[zZ]$|[+-]\d\d:\d\d$/.test(input);
  const normalized = hasZone ? input : `${input}Z`;
  const iso = new Date(normalized).toISOString();
  return {
    dateTime: iso,
    timeZone: "UTC",
  };
}

function normalizeAllDay(raw: GraphDateTimeTimeZone): { date: string } {
  return { date: raw.dateTime.slice(0, 10) };
}

function normalizeDescription(event: GraphEvent): string {
  if (event.body?.content) {
    if (event.body.contentType === "text") {
      return event.body.content;
    }
    return stripHtml(event.body.content);
  }
  return event.bodyPreview ?? "";
}

export function normalizeOutlookEvent(event: GraphEvent): SourceEvent | null {
  if (!event.id || !event.start || !event.end) {
    return null;
  }

  // calendarView may return series master and occurrences; syncing masters causes duplicates.
  if (event.type === "seriesMaster") {
    return null;
  }

  const isAllDay = Boolean(event.isAllDay);

  const start = isAllDay ? normalizeAllDay(event.start) : normalizeDateTime(event.start);
  const end = isAllDay ? normalizeAllDay(event.end) : normalizeDateTime(event.end);

  return {
    id: event.id,
    iCalUid: event.iCalUId ?? null,
    title: event.subject?.trim() || "(No title)",
    description: normalizeDescription(event),
    location: event.location?.displayName?.trim() || "",
    start,
    end,
    isAllDay,
    isCancelled: Boolean(event.isCancelled),
    lastModifiedDateTime: event.lastModifiedDateTime ?? null,
    reminderMinutesBeforeStart:
      typeof event.reminderMinutesBeforeStart === "number"
        ? event.reminderMinutesBeforeStart
        : null,
    isRecurringMaster: event.type === "seriesMaster",
    seriesMasterId: event.seriesMasterId ?? null,
  };
}

function buildReminder(reminderMinutesBeforeStart: number | null) {
  if (reminderMinutesBeforeStart === null || reminderMinutesBeforeStart < 0) {
    return { useDefault: true };
  }

  const boundedMinutes = Math.max(0, Math.min(reminderMinutesBeforeStart, 40_320));
  return {
    useDefault: false,
    overrides: [
      {
        method: "popup" as const,
        minutes: boundedMinutes,
      },
    ],
  };
}

export function toGoogleEventPayload(source: SourceEvent, subscriptionId: string): GoogleEventInput {
  return {
    summary: source.title,
    description: source.description,
    location: source.location || undefined,
    start: source.start,
    end: source.end,
    reminders: buildReminder(source.reminderMinutesBeforeStart),
    extendedProperties: {
      private: {
        app: APP_MARKER,
        source: "outlook",
        subscription_id: subscriptionId,
        outlook_event_id: source.id,
      },
    },
  };
}

export function getAppMarker(): string {
  return APP_MARKER;
}
