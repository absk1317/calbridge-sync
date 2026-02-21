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

  it("skips series masters when expanded recurring instances exist", () => {
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
      "DTSTART:20260303T150000Z",
      "DTEND:20260303T153000Z",
      "SUMMARY:Daily Sync (instance)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");

    const result = parseIcsToSourceEvents(
      ics,
      "2026-03-01T00:00:00.000Z",
      "2026-03-10T00:00:00.000Z",
    );

    expect(result.fetchedCount).toBe(2);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].id).toBe("series-1::20260303T150000Z");
  });
});
