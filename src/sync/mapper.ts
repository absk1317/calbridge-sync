import type { GoogleEventInput, GoogleSourceEvent } from "../clients/google-calendar.js";
import type { GraphDateTimeTimeZone, GraphEvent } from "../clients/microsoft-graph.js";
import type { SourceMode } from "../config.js";
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

function normalizeGoogleDateTime(
  raw: { date?: string; dateTime?: string } | undefined,
): { dateTime: string; timeZone: string } | { date: string } | null {
  if (!raw) {
    return null;
  }

  if (raw.date) {
    return { date: raw.date };
  }

  if (!raw.dateTime) {
    return null;
  }

  const hasZone = /[zZ]$|[+-]\d\d:\d\d$/.test(raw.dateTime);
  const normalized = hasZone ? raw.dateTime : `${raw.dateTime}Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return {
    dateTime: parsed.toISOString(),
    timeZone: "UTC",
  };
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

export function normalizeGoogleCalendarEvent(event: GoogleSourceEvent): SourceEvent | null {
  if (!event.id || !event.start || !event.end) {
    return null;
  }

  const normalizedStart = normalizeGoogleDateTime(event.start);
  const normalizedEnd = normalizeGoogleDateTime(event.end);
  if (!normalizedStart || !normalizedEnd) {
    return null;
  }

  const isAllDay = "date" in normalizedStart;
  const reminderOverride = event.reminders?.overrides?.find((override) => override.method === "popup");

  return {
    id: event.id,
    iCalUid: event.iCalUID ?? null,
    title: event.summary?.trim() || "(No title)",
    description: event.description ?? "",
    location: event.location?.trim() || "",
    start: normalizedStart,
    end: normalizedEnd,
    isAllDay,
    isCancelled: event.status === "cancelled",
    lastModifiedDateTime: event.updated ?? null,
    reminderMinutesBeforeStart:
      typeof reminderOverride?.minutes === "number" ? reminderOverride.minutes : null,
    isRecurringMaster: false,
    seriesMasterId: event.recurringEventId ?? null,
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

export function toGoogleEventPayload(
  source: SourceEvent,
  subscriptionId: string,
  sourceMode: SourceMode,
): GoogleEventInput {
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
        source: sourceMode,
        source_mode: sourceMode,
        subscription_id: subscriptionId,
        source_event_id: source.id,
        // Backward compatibility with earlier marker key used by existing installs.
        outlook_event_id: source.id,
      },
    },
  };
}

export function getAppMarker(): string {
  return APP_MARKER;
}
