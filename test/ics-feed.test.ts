import { describe, expect, it } from "vitest";
import { parseIcsToSourceEvents } from "../src/clients/ics-feed.js";

describe("parseIcsToSourceEvents", () => {
  it("parses timed and all-day events", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-1",
      "DTSTART:20260301T150000Z",
      "DTEND:20260301T153000Z",
      "SUMMARY:Team\\, Sync",
      "DESCRIPTION:Line1\\nLine2",
      "LOCATION:Room\\;A",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:evt-2",
      "DTSTART;VALUE=DATE:20260302",
      "DTEND;VALUE=DATE:20260303",
      "SUMMARY:Day Off",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-02-28T00:00:00.000Z",
      "2026-03-05T00:00:00.000Z",
    );

    expect(result.fetchedCount).toBe(2);
    expect(result.events).toHaveLength(2);

    expect(result.events[0].title).toBe("Team, Sync");
    expect(result.events[0].description).toBe("Line1\nLine2");
    expect(result.events[0].location).toBe("Room;A");
    expect(result.events[0].start.dateTime).toBe("2026-03-01T15:00:00.000Z");

    expect(result.events[1].isAllDay).toBe(true);
    expect(result.events[1].start.date).toBe("2026-03-02");
    expect(result.events[1].end.date).toBe("2026-03-03");
  });

  it("preserves canceled events for reconciliation", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:evt-cancel",
      "DTSTART:20260304T100000Z",
      "DTEND:20260304T110000Z",
      "STATUS:CANCELLED",
      "SUMMARY:Canceled Meeting",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-03-01T00:00:00.000Z",
      "2026-03-10T00:00:00.000Z",
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].isCancelled).toBe(true);
  });

  it("expands recurring masters and applies recurrence overrides", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:series-1",
      "DTSTART:20260303T150000Z",
      "DTEND:20260303T153000Z",
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:Daily Sync",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:series-1",
      "RECURRENCE-ID:20260303T150000Z",
      "DTSTART:20260303T160000Z",
      "DTEND:20260303T163000Z",
      "SUMMARY:Daily Sync (moved)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-03-01T00:00:00.000Z",
      "2026-03-10T00:00:00.000Z",
    );

    expect(result.fetchedCount).toBe(2);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].id).toBe("series-1::2026-03-03T15:00:00.000Z");
    expect(result.events[0].title).toBe("Daily Sync (moved)");
    expect(result.events[0].start.dateTime).toBe("2026-03-03T16:00:00.000Z");
    expect(result.events[1].id).toBe("series-1::2026-03-04T15:00:00.000Z");
  });

  it("expands recurring masters that start before the sync window", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:series-2",
      "DTSTART:20260101T150000Z",
      "DTEND:20260101T153000Z",
      "RRULE:FREQ=WEEKLY;COUNT=20",
      "SUMMARY:Weekly Sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-03-01T00:00:00.000Z",
      "2026-03-10T00:00:00.000Z",
    );

    expect(result.fetchedCount).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("series-2::2026-03-05T15:00:00.000Z");
    expect(result.events[0].start.dateTime).toBe("2026-03-05T15:00:00.000Z");
  });

  it("keeps local wall-clock time for TZID recurrences across DST seasons", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:series-dst",
      "DTSTART;TZID=America/Toronto:20250701T113000",
      "DTEND;TZID=America/Toronto:20250701T120000",
      "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=80",
      "SUMMARY:Weekly 11:30",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-02-23T00:00:00.000Z",
      "2026-02-28T00:00:00.000Z",
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].start.dateTime).toBe("2026-02-24T16:30:00.000Z");
  });

  it("expands non-local TZID recurrences at correct UTC instant", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:series-la",
      "DTSTART;TZID=America/Los_Angeles:20260223T113000",
      "DTEND;TZID=America/Los_Angeles:20260223T120000",
      "RRULE:FREQ=DAILY;COUNT=2",
      "SUMMARY:LA Daily",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-02-23T00:00:00.000Z",
      "2026-02-26T00:00:00.000Z",
    );

    expect(result.events).toHaveLength(2);
    expect(result.events[0].start.dateTime).toBe("2026-02-23T19:30:00.000Z");
    expect(result.events[1].start.dateTime).toBe("2026-02-24T19:30:00.000Z");
  });

  it("parses TZID-based local times into correct UTC instants", () => {
    const ics = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:tzid-1",
      "DTSTART;TZID=America/Toronto:20260303T090000",
      "DTEND;TZID=America/Toronto:20260303T100000",
      "SUMMARY:Morning Sync",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-03-01T00:00:00.000Z",
      "2026-03-10T00:00:00.000Z",
    );

    expect(result.events).toHaveLength(1);
    expect(result.events[0].start.dateTime).toBe("2026-03-03T14:00:00.000Z");
    expect(result.events[0].end.dateTime).toBe("2026-03-03T15:00:00.000Z");
  });
});
