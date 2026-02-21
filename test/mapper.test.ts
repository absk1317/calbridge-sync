import { describe, expect, it } from "vitest";
import type { GraphEvent } from "../src/clients/microsoft-graph.js";
import { normalizeOutlookEvent, toGoogleEventPayload } from "../src/sync/mapper.js";

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

    const payload = toGoogleEventPayload(source);
    expect(payload.extendedProperties.private.app).toBe("outlook-google-sync");
    expect(payload.extendedProperties.private.outlook_event_id).toBe("evt-1");
    expect(payload.reminders?.useDefault).toBe(false);
    expect(payload.reminders?.overrides?.[0]?.minutes).toBe(10);
  });
});
