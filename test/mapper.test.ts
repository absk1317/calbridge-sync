import { describe, expect, it } from "vitest";
import type { GoogleSourceEvent } from "../src/clients/google-calendar.js";
import type { GraphEvent } from "../src/clients/microsoft-graph.js";
import {
  normalizeGoogleCalendarEvent,
  normalizeOutlookEvent,
  toGoogleEventPayload,
} from "../src/sync/mapper.js";

describe("normalizeOutlookEvent", () => {
  it("normalizes timed events to UTC dateTime", () => {
    const raw: GraphEvent = {
      id: "evt-1",
      subject: "Team Sync",
      bodyPreview: "Discuss roadmap",
      start: { dateTime: "2026-03-01T15:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-03-01T15:30:00.0000000", timeZone: "UTC" },
      isAllDay: false,
      isCancelled: false,
      reminderMinutesBeforeStart: 15,
      location: { displayName: "Room 1" },
      lastModifiedDateTime: "2026-03-01T10:00:00Z",
    };

    const normalized = normalizeOutlookEvent(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.start.dateTime).toBe("2026-03-01T15:00:00.000Z");
    expect(normalized?.end.dateTime).toBe("2026-03-01T15:30:00.000Z");
  });

  it("normalizes all-day events using date fields", () => {
    const raw: GraphEvent = {
      id: "evt-2",
      subject: "Holiday",
      start: { dateTime: "2026-12-25T00:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-12-26T00:00:00.0000000", timeZone: "UTC" },
      isAllDay: true,
    };

    const normalized = normalizeOutlookEvent(raw);
    expect(normalized?.start.date).toBe("2026-12-25");
    expect(normalized?.end.date).toBe("2026-12-26");
  });

  it("skips recurring series master records", () => {
    const raw: GraphEvent = {
      id: "master-1",
      type: "seriesMaster",
      start: { dateTime: "2026-03-01T15:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-03-01T15:30:00.0000000", timeZone: "UTC" },
    };

    expect(normalizeOutlookEvent(raw)).toBeNull();
  });
});

describe("toGoogleEventPayload", () => {
  it("applies ownership markers and reminder mapping", () => {
    const source = {
      id: "evt-1",
      iCalUid: null,
      title: "Standup",
      description: "Daily sync",
      location: "Zoom",
      start: { dateTime: "2026-03-02T12:00:00.000Z", timeZone: "UTC" },
      end: { dateTime: "2026-03-02T12:15:00.000Z", timeZone: "UTC" },
      isAllDay: false,
      isCancelled: false,
      lastModifiedDateTime: "2026-03-02T10:00:00Z",
      reminderMinutesBeforeStart: 10,
      isRecurringMaster: false,
      seriesMasterId: null,
    };

    const payload = toGoogleEventPayload(source, "work-primary", "microsoft");
    expect(payload.extendedProperties.private.app).toBe("outlook-google-sync");
    expect(payload.extendedProperties.private.source).toBe("microsoft");
    expect(payload.extendedProperties.private.source_mode).toBe("microsoft");
    expect(payload.extendedProperties.private.subscription_id).toBe("work-primary");
    expect(payload.extendedProperties.private.source_event_id).toBe("evt-1");
    expect(payload.extendedProperties.private.outlook_event_id).toBe("evt-1");
    expect(payload.reminders?.useDefault).toBe(false);
    expect(payload.reminders?.overrides?.[0]?.minutes).toBe(10);
  });
});

describe("normalizeGoogleCalendarEvent", () => {
  it("normalizes timed Google source events to UTC dateTime", () => {
    const raw: GoogleSourceEvent = {
      id: "g-evt-1",
      iCalUID: "ical-1",
      summary: "Work Sync",
      description: "agenda",
      location: "Meet",
      status: "confirmed",
      updated: "2026-03-01T10:00:00Z",
      start: { dateTime: "2026-03-01T11:30:00-05:00" },
      end: { dateTime: "2026-03-01T12:00:00-05:00" },
      reminders: { overrides: [{ method: "popup", minutes: 5 }] },
    };

    const normalized = normalizeGoogleCalendarEvent(raw);
    expect(normalized).not.toBeNull();
    expect(normalized?.start.dateTime).toBe("2026-03-01T16:30:00.000Z");
    expect(normalized?.end.dateTime).toBe("2026-03-01T17:00:00.000Z");
    expect(normalized?.reminderMinutesBeforeStart).toBe(5);
  });

  it("normalizes all-day Google source events", () => {
    const raw: GoogleSourceEvent = {
      id: "g-evt-2",
      summary: "Holiday",
      status: "confirmed",
      start: { date: "2026-12-25" },
      end: { date: "2026-12-26" },
    };

    const normalized = normalizeGoogleCalendarEvent(raw);
    expect(normalized?.isAllDay).toBe(true);
    expect(normalized?.start.date).toBe("2026-12-25");
    expect(normalized?.end.date).toBe("2026-12-26");
  });
});
