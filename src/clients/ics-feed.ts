import type pino from "pino";
import { HttpError, requestText } from "../http.js";
import { withRetry } from "../retry.js";
import type { SourceEvent } from "../sync/types.js";

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface IntermediateEvent {
  event: SourceEvent;
  startMs: number;
  endMs: number;
  hasRrule: boolean;
  recurrenceId: string | null;
  uid: string;
}

function unfoldIcsLines(icsText: string): string[] {
  const rawLines = icsText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];

  for (const rawLine of rawLines) {
    if ((rawLine.startsWith(" ") || rawLine.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += rawLine.slice(1);
      continue;
    }
    lines.push(rawLine);
  }

  return lines;
}

function parseProperty(line: string): IcsProperty | null {
  const colonIndex = line.indexOf(":");
  if (colonIndex < 0) {
    return null;
  }

  const head = line.slice(0, colonIndex);
  const value = line.slice(colonIndex + 1);
  const [rawName, ...rawParams] = head.split(";");

  if (!rawName) {
    return null;
  }

  const params: Record<string, string> = {};
  for (const rawParam of rawParams) {
    const eqIndex = rawParam.indexOf("=");
    if (eqIndex < 0) {
      continue;
    }

    const key = rawParam.slice(0, eqIndex).toUpperCase();
    const rawValue = rawParam.slice(eqIndex + 1).trim();
    params[key] = rawValue.replace(/^"|"$/g, "");
  }

  return {
    name: rawName.toUpperCase(),
    params,
    value,
  };
}

function unescapeIcsText(input: string): string {
  return input
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function parseDateOnly(value: string): { date: string; startMs: number } | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  const date = `${year}-${month}-${day}`;
  return {
    date,
    startMs: Date.UTC(Number(year), Number(month) - 1, Number(day), 0, 0, 0),
  };
}

function parseDateTime(value: string): { iso: string; epochMs: number } | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (!match) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return {
      iso: parsed.toISOString(),
      epochMs: parsed.getTime(),
    };
  }

  const [, year, month, day, hour, minute, second, zulu] = match;
  const secondValue = Number(second ?? "0");

  const parsed = zulu
    ? new Date(
        Date.UTC(
          Number(year),
          Number(month) - 1,
          Number(day),
          Number(hour),
          Number(minute),
          secondValue,
        ),
      )
    : new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        secondValue,
      );

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return {
    iso: parsed.toISOString(),
    epochMs: parsed.getTime(),
  };
}

function parseTemporal(prop: IcsProperty):
  | {
      isAllDay: true;
      date: string;
      startMs: number;
      identityToken: string;
    }
  | {
      isAllDay: false;
      dateTime: string;
      startMs: number;
      identityToken: string;
    }
  | null {
  const isDateOnly = prop.params.VALUE?.toUpperCase() === "DATE" || /^\d{8}$/.test(prop.value);

  if (isDateOnly) {
    const parsed = parseDateOnly(prop.value);
    if (!parsed) {
      return null;
    }
    return {
      isAllDay: true,
      date: parsed.date,
      startMs: parsed.startMs,
      identityToken: parsed.date,
    };
  }

  const parsedDateTime = parseDateTime(prop.value);
  if (!parsedDateTime) {
    return null;
  }

  return {
    isAllDay: false,
    dateTime: parsedDateTime.iso,
    startMs: parsedDateTime.epochMs,
    identityToken: prop.value,
  };
}

function getFirstProperty(props: IcsProperty[], name: string): IcsProperty | undefined {
  return props.find((prop) => prop.name === name);
}

function buildIntermediateEvent(props: IcsProperty[]): IntermediateEvent | null {
  const uid = getFirstProperty(props, "UID")?.value.trim();
  const dtStartProp = getFirstProperty(props, "DTSTART");

  if (!uid || !dtStartProp) {
    return null;
  }

  const startTemporal = parseTemporal(dtStartProp);
  if (!startTemporal) {
    return null;
  }

  const dtEndProp = getFirstProperty(props, "DTEND");
  let endMs: number;
  let end:
    | {
        date: string;
      }
    | {
        dateTime: string;
        timeZone: "UTC";
      };

  if (dtEndProp) {
    const endTemporal = parseTemporal(dtEndProp);
    if (!endTemporal) {
      return null;
    }

    endMs = endTemporal.startMs;
    end = endTemporal.isAllDay
      ? {
          date: endTemporal.date,
        }
      : {
          dateTime: endTemporal.dateTime,
          timeZone: "UTC",
        };
  } else if (startTemporal.isAllDay) {
    endMs = startTemporal.startMs + 24 * 60 * 60 * 1000;
    const fallbackDate = new Date(endMs).toISOString().slice(0, 10);
    end = {
      date: fallbackDate,
    };
  } else {
    endMs = startTemporal.startMs + 30 * 60 * 1000;
    end = {
      dateTime: new Date(endMs).toISOString(),
      timeZone: "UTC",
    };
  }

  if (endMs <= startTemporal.startMs) {
    return null;
  }

  const recurrenceIdProp = getFirstProperty(props, "RECURRENCE-ID");
  const recurrenceId = recurrenceIdProp ? parseTemporal(recurrenceIdProp)?.identityToken ?? null : null;
  const id = recurrenceId ? `${uid}::${recurrenceId}` : uid;

  const status = getFirstProperty(props, "STATUS")?.value.toUpperCase();
  const hasRrule = Boolean(getFirstProperty(props, "RRULE"));

  const lastModifiedProp = getFirstProperty(props, "LAST-MODIFIED");
  const lastModified = lastModifiedProp ? parseTemporal(lastModifiedProp) : null;

  const event: SourceEvent = {
    id,
    iCalUid: uid,
    title: unescapeIcsText(getFirstProperty(props, "SUMMARY")?.value ?? "(No title)"),
    description: unescapeIcsText(getFirstProperty(props, "DESCRIPTION")?.value ?? ""),
    location: unescapeIcsText(getFirstProperty(props, "LOCATION")?.value ?? ""),
    start: startTemporal.isAllDay
      ? {
          date: startTemporal.date,
        }
      : {
          dateTime: startTemporal.dateTime,
          timeZone: "UTC",
        },
    end,
    isAllDay: startTemporal.isAllDay,
    isCancelled: status === "CANCELLED",
    lastModifiedDateTime:
      lastModified && !lastModified.isAllDay ? lastModified.dateTime : new Date(startTemporal.startMs).toISOString(),
    reminderMinutesBeforeStart: null,
    isRecurringMaster: hasRrule && !recurrenceId,
    seriesMasterId: recurrenceId ? uid : null,
  };

  return {
    event,
    startMs: startTemporal.startMs,
    endMs,
    hasRrule,
    recurrenceId,
    uid,
  };
}

function overlapsWindow(
  eventStartMs: number,
  eventEndMs: number,
  windowStartMs: number,
  windowEndMs: number,
): boolean {
  return eventEndMs > windowStartMs && eventStartMs < windowEndMs;
}

export function parseIcsToSourceEvents(
  icsText: string,
  startIso: string,
  endIso: string,
): { fetchedCount: number; events: SourceEvent[] } {
  const lines = unfoldIcsLines(icsText);
  const windowStartMs = new Date(startIso).getTime();
  const windowEndMs = new Date(endIso).getTime();

  if (Number.isNaN(windowStartMs) || Number.isNaN(windowEndMs)) {
    throw new Error("Invalid sync window while parsing ICS feed");
  }

  const eventBlocks: IcsProperty[][] = [];
  let currentBlock: IcsProperty[] | null = null;

  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      currentBlock = [];
      continue;
    }

    if (line === "END:VEVENT") {
      if (currentBlock) {
        eventBlocks.push(currentBlock);
      }
      currentBlock = null;
      continue;
    }

    if (!currentBlock) {
      continue;
    }

    const parsed = parseProperty(line);
    if (parsed) {
      currentBlock.push(parsed);
    }
  }

  const intermediateEvents = eventBlocks
    .map((block) => buildIntermediateEvent(block))
    .filter((event): event is IntermediateEvent => Boolean(event));

  const recurrenceInstancesByUid = new Map<string, number>();
  for (const event of intermediateEvents) {
    if (event.recurrenceId) {
      recurrenceInstancesByUid.set(event.uid, (recurrenceInstancesByUid.get(event.uid) ?? 0) + 1);
    }
  }

  const filtered = intermediateEvents.filter((entry) => {
    if (!overlapsWindow(entry.startMs, entry.endMs, windowStartMs, windowEndMs)) {
      return false;
    }

    if (entry.hasRrule && !entry.recurrenceId && (recurrenceInstancesByUid.get(entry.uid) ?? 0) > 0) {
      // Avoid duplicate series-master events when expanded instances are already present.
      return false;
    }

    return true;
  });

  return {
    fetchedCount: intermediateEvents.length,
    events: filtered.map((entry) => entry.event),
  };
}

export class IcsFeedClient {
  constructor(
    private readonly icsUrl: string,
    private readonly logger: pino.Logger,
  ) {}

  async listEvents(startIso: string, endIso: string): Promise<{ fetchedCount: number; events: SourceEvent[] }> {
    const body = await withRetry(this.logger, "ics_fetch", async () => {
      return requestText(this.icsUrl, {
        headers: {
          Accept: "text/calendar, text/plain;q=0.9, */*;q=0.8",
        },
      });
    });

    return parseIcsToSourceEvents(body, startIso, endIso);
  }

  async healthCheck(): Promise<void> {
    const body = await withRetry(this.logger, "ics_health", async () => {
      return requestText(this.icsUrl, {
        headers: {
          Accept: "text/calendar, text/plain;q=0.9, */*;q=0.8",
        },
      });
    });

    if (!body.includes("BEGIN:VCALENDAR")) {
      throw new HttpError(
        "ICS health check failed: response is not a VCALENDAR payload",
        502,
        body.slice(0, 200),
        new Headers(),
      );
    }
  }
}
