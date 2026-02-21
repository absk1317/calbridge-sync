import type pino from "pino";
import * as RRuleModule from "rrule";
import { HttpError, requestText } from "../http.js";
import { withRetry } from "../retry.js";
import type { SourceEvent } from "../sync/types.js";

const RRuleCtor =
  (RRuleModule as unknown as { RRule?: typeof import("rrule").RRule }).RRule ??
  (
    RRuleModule as unknown as { default?: { RRule?: typeof import("rrule").RRule } }
  ).default?.RRule;

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

interface IntermediateEvent {
  event: SourceEvent;
  startMs: number;
  endMs: number;
  durationMs: number;
  hasRrule: boolean;
  rrule: string | null;
  recurrenceId: string | null;
  occurrenceToken: string;
  recurrenceTimeZone: string | undefined;
  exdateTokens: Set<string>;
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

const WINDOWS_TIMEZONE_TO_IANA: Record<string, string> = {
  "UTC": "UTC",
  "GMT Standard Time": "Europe/London",
  "W. Europe Standard Time": "Europe/Berlin",
  "Central Europe Standard Time": "Europe/Budapest",
  "Romance Standard Time": "Europe/Paris",
  "E. Europe Standard Time": "Europe/Bucharest",
  "Russian Standard Time": "Europe/Moscow",
  "Israel Standard Time": "Asia/Jerusalem",
  "Arab Standard Time": "Asia/Riyadh",
  "India Standard Time": "Asia/Kolkata",
  "Singapore Standard Time": "Asia/Singapore",
  "China Standard Time": "Asia/Shanghai",
  "Tokyo Standard Time": "Asia/Tokyo",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "New Zealand Standard Time": "Pacific/Auckland",
  "Eastern Standard Time": "America/New_York",
  "Central Standard Time": "America/Chicago",
  "Mountain Standard Time": "America/Denver",
  "Pacific Standard Time": "America/Los_Angeles",
  "Alaskan Standard Time": "America/Anchorage",
  "Hawaiian Standard Time": "Pacific/Honolulu",
};

const dateTimeFormatCache = new Map<string, Intl.DateTimeFormat>();
const validTimeZoneCache = new Map<string, boolean>();

function isValidIanaTimeZone(timeZone: string): boolean {
  if (validTimeZoneCache.has(timeZone)) {
    return validTimeZoneCache.get(timeZone) ?? false;
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    validTimeZoneCache.set(timeZone, true);
    return true;
  } catch {
    validTimeZoneCache.set(timeZone, false);
    return false;
  }
}

function toValidIanaTimeZone(rawTzid: string | undefined): string | undefined {
  if (!rawTzid) {
    return undefined;
  }

  const cleaned = rawTzid.trim().replace(/^"(.*)"$/, "$1");
  if (!cleaned) {
    return undefined;
  }

  const mapped = WINDOWS_TIMEZONE_TO_IANA[cleaned];
  if (mapped && isValidIanaTimeZone(mapped)) {
    return mapped;
  }

  if (isValidIanaTimeZone(cleaned)) {
    return cleaned;
  }

  // Some feeds publish TZID like /mozilla.org/20050126_1/America/Toronto.
  const slashSeparated = cleaned.split("/").filter(Boolean);
  for (let i = 0; i < slashSeparated.length; i += 1) {
    const candidate = slashSeparated.slice(i).join("/");
    if (isValidIanaTimeZone(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function getDateTimeFormat(timeZone: string): Intl.DateTimeFormat {
  const cached = dateTimeFormatCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  dateTimeFormatCache.set(timeZone, formatter);
  return formatter;
}

function extractPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  const part = parts.find((entry) => entry.type === type);
  return Number(part?.value ?? "0");
}

function getTimeZoneOffsetMs(timeZone: string, epochMs: number): number {
  const parts = getDateTimeFormat(timeZone).formatToParts(new Date(epochMs));
  const year = extractPart(parts, "year");
  const month = extractPart(parts, "month");
  const day = extractPart(parts, "day");
  const hour = extractPart(parts, "hour");
  const minute = extractPart(parts, "minute");
  const second = extractPart(parts, "second");
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  return asUtc - epochMs;
}

function getWallClockPartsInTimeZone(
  epochMs: number,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = getDateTimeFormat(timeZone).formatToParts(new Date(epochMs));
  return {
    year: extractPart(parts, "year"),
    month: extractPart(parts, "month"),
    day: extractPart(parts, "day"),
    hour: extractPart(parts, "hour"),
    minute: extractPart(parts, "minute"),
    second: extractPart(parts, "second"),
  };
}

function toEpochMsForTimeZone(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = localAsUtc;

  // A few rounds converges on the correct offset across DST boundaries.
  for (let i = 0; i < 4; i += 1) {
    const offset = getTimeZoneOffsetMs(timeZone, guess);
    guess = localAsUtc - offset;
  }

  return guess;
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

function parseDateTime(
  value: string,
  rawTzid: string | undefined,
): { iso: string; epochMs: number; timeZone: string | undefined } | null {
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i);
  if (!match) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return {
      iso: parsed.toISOString(),
      epochMs: parsed.getTime(),
      timeZone: undefined,
    };
  }

  const [, year, month, day, hour, minute, second, zulu] = match;
  const secondValue = Number(second ?? "0");

  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  const ianaTimeZone = !zulu ? toValidIanaTimeZone(rawTzid) : undefined;

  let epochMs: number;
  if (zulu) {
    epochMs = Date.UTC(
      yearNumber,
      monthNumber - 1,
      dayNumber,
      hourNumber,
      minuteNumber,
      secondValue,
    );
  } else {
    if (ianaTimeZone) {
      epochMs = toEpochMsForTimeZone(
        yearNumber,
        monthNumber,
        dayNumber,
        hourNumber,
        minuteNumber,
        secondValue,
        ianaTimeZone,
      );
    } else {
      epochMs = new Date(
        yearNumber,
        monthNumber - 1,
        dayNumber,
        hourNumber,
        minuteNumber,
        secondValue,
      ).getTime();
    }
  }

  const parsed = new Date(epochMs);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return {
    iso: parsed.toISOString(),
    epochMs: parsed.getTime(),
    timeZone: ianaTimeZone,
  };
}

function toUtcDateString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

function toTemporalIdentityToken(isAllDay: boolean, startMs: number, date: string): string {
  if (isAllDay) {
    return date;
  }
  return new Date(startMs).toISOString();
}

function parseTemporal(prop: IcsProperty):
  | {
      isAllDay: true;
      date: string;
      startMs: number;
      identityToken: string;
      recurrenceTimeZone: undefined;
    }
  | {
      isAllDay: false;
      dateTime: string;
      startMs: number;
      identityToken: string;
      recurrenceTimeZone: string | undefined;
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
      identityToken: toTemporalIdentityToken(true, parsed.startMs, parsed.date),
      recurrenceTimeZone: undefined,
    };
  }

  const parsedDateTime = parseDateTime(prop.value, prop.params.TZID);
  if (!parsedDateTime) {
    return null;
  }

  return {
    isAllDay: false,
    dateTime: parsedDateTime.iso,
    startMs: parsedDateTime.epochMs,
    identityToken: toTemporalIdentityToken(
      false,
      parsedDateTime.epochMs,
      toUtcDateString(parsedDateTime.epochMs),
    ),
    recurrenceTimeZone: parsedDateTime.timeZone,
  };
}

function getFirstProperty(props: IcsProperty[], name: string): IcsProperty | undefined {
  return props.find((prop) => prop.name === name);
}

function getAllProperties(props: IcsProperty[], name: string): IcsProperty[] {
  return props.filter((prop) => prop.name === name);
}

function parseMultiValueTemporalTokens(prop: IcsProperty): string[] {
  const rawValues = prop.value
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  const tokens: string[] = [];
  for (const value of rawValues) {
    const parsed = parseTemporal({
      ...prop,
      value,
    });
    if (parsed) {
      tokens.push(parsed.identityToken);
    }
  }

  return tokens;
}

function buildEventTimes(
  isAllDay: boolean,
  startMs: number,
  endMs: number,
): {
  start: SourceEvent["start"];
  end: SourceEvent["end"];
} {
  if (isAllDay) {
    return {
      start: {
        date: toUtcDateString(startMs),
      },
      end: {
        date: toUtcDateString(endMs),
      },
    };
  }

  return {
    start: {
      dateTime: new Date(startMs).toISOString(),
      timeZone: "UTC",
    },
    end: {
      dateTime: new Date(endMs).toISOString(),
      timeZone: "UTC",
    },
  };
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

  if (dtEndProp) {
    const endTemporal = parseTemporal(dtEndProp);
    if (!endTemporal) {
      return null;
    }

    endMs = endTemporal.startMs;
  } else if (startTemporal.isAllDay) {
    endMs = startTemporal.startMs + 24 * 60 * 60 * 1000;
  } else {
    endMs = startTemporal.startMs + 30 * 60 * 1000;
  }

  if (endMs <= startTemporal.startMs) {
    return null;
  }

  const recurrenceIdProp = getFirstProperty(props, "RECURRENCE-ID");
  const recurrenceId = recurrenceIdProp ? parseTemporal(recurrenceIdProp)?.identityToken ?? null : null;
  const id = recurrenceId ? `${uid}::${recurrenceId}` : uid;

  const status = getFirstProperty(props, "STATUS")?.value.toUpperCase();
  const rrule = getFirstProperty(props, "RRULE")?.value.trim() ?? null;
  const hasRrule = Boolean(rrule);
  const exdateTokens = new Set<string>();
  for (const exdateProp of getAllProperties(props, "EXDATE")) {
    for (const token of parseMultiValueTemporalTokens(exdateProp)) {
      exdateTokens.add(token);
    }
  }

  const lastModifiedProp = getFirstProperty(props, "LAST-MODIFIED");
  const lastModified = lastModifiedProp ? parseTemporal(lastModifiedProp) : null;
  const eventTimes = buildEventTimes(startTemporal.isAllDay, startTemporal.startMs, endMs);

  const event: SourceEvent = {
    id,
    iCalUid: uid,
    title: unescapeIcsText(getFirstProperty(props, "SUMMARY")?.value ?? "(No title)"),
    description: unescapeIcsText(getFirstProperty(props, "DESCRIPTION")?.value ?? ""),
    location: unescapeIcsText(getFirstProperty(props, "LOCATION")?.value ?? ""),
    start: eventTimes.start,
    end: eventTimes.end,
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
    durationMs: endMs - startTemporal.startMs,
    hasRrule,
    rrule,
    recurrenceId,
    occurrenceToken: recurrenceId ?? startTemporal.identityToken,
    recurrenceTimeZone: startTemporal.recurrenceTimeZone,
    exdateTokens,
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

function buildExpandedOccurrence(master: IntermediateEvent, startMs: number, endMs: number): IntermediateEvent {
  const token = toTemporalIdentityToken(master.event.isAllDay, startMs, toUtcDateString(startMs));
  const eventTimes = buildEventTimes(master.event.isAllDay, startMs, endMs);

  return {
    event: {
      ...master.event,
      id: `${master.uid}::${token}`,
      start: eventTimes.start,
      end: eventTimes.end,
      isRecurringMaster: false,
      seriesMasterId: master.uid,
    },
    startMs,
    endMs,
    durationMs: endMs - startMs,
    hasRrule: false,
    rrule: null,
    recurrenceId: token,
    occurrenceToken: token,
    recurrenceTimeZone: master.recurrenceTimeZone,
    exdateTokens: new Set<string>(),
    uid: master.uid,
  };
}

function expandRecurringMaster(
  master: IntermediateEvent,
  windowStartMs: number,
  windowEndMs: number,
): IntermediateEvent[] {
  if (!master.rrule) {
    return [];
  }
  if (!RRuleCtor) {
    if (overlapsWindow(master.startMs, master.endMs, windowStartMs, windowEndMs)) {
      return [master];
    }
    return [];
  }

  try {
    const parsedOptions = RRuleCtor.parseString(master.rrule);
    const recurrenceTzid = master.recurrenceTimeZone ?? parsedOptions.tzid;
    const hasTimeZoneRule = Boolean(recurrenceTzid && !master.event.isAllDay);
    const dtstartForRule =
      recurrenceTzid && hasTimeZoneRule
        ? toFloatingUtcDate(master.startMs, recurrenceTzid)
        : new Date(master.startMs);
    const rule = new RRuleCtor({
      ...parsedOptions,
      dtstart: dtstartForRule,
      tzid: recurrenceTzid,
    });

    const searchStart = new Date(windowStartMs - master.durationMs);
    const searchEnd = new Date(windowEndMs);
    const starts = rule.between(searchStart, searchEnd, true);

    const expanded: IntermediateEvent[] = [];
    for (const occurrenceStart of starts) {
      const startMs = normalizeRRuleOccurrenceMs(occurrenceStart, hasTimeZoneRule);
      const endMs = startMs + master.durationMs;
      const token = toTemporalIdentityToken(master.event.isAllDay, startMs, toUtcDateString(startMs));

      if (master.exdateTokens.has(token)) {
        continue;
      }

      if (!overlapsWindow(startMs, endMs, windowStartMs, windowEndMs)) {
        continue;
      }

      expanded.push(buildExpandedOccurrence(master, startMs, endMs));
    }

    return expanded;
  } catch {
    if (overlapsWindow(master.startMs, master.endMs, windowStartMs, windowEndMs)) {
      return [master];
    }
    return [];
  }
}

function getLastModifiedEpoch(entry: IntermediateEvent): number {
  const parsed = Date.parse(entry.event.lastModifiedDateTime ?? "");
  if (!Number.isNaN(parsed)) {
    return parsed;
  }
  return entry.startMs;
}

function normalizeRRuleOccurrenceMs(occurrence: Date, hasTimeZoneRule: boolean): number {
  if (!hasTimeZoneRule) {
    return occurrence.getTime();
  }

  // rrule.js emits tzid recurrences as floating UTC fields; reinterpret as local time.
  return new Date(
    occurrence.getUTCFullYear(),
    occurrence.getUTCMonth(),
    occurrence.getUTCDate(),
    occurrence.getUTCHours(),
    occurrence.getUTCMinutes(),
    occurrence.getUTCSeconds(),
    occurrence.getUTCMilliseconds(),
  ).getTime();
}

function toFloatingUtcDate(epochMs: number, recurrenceTzid: string): Date {
  const parts = getWallClockPartsInTimeZone(epochMs, recurrenceTzid);
  return new Date(
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    ),
  );
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

  const recurringMastersByUid = new Map<string, IntermediateEvent>();
  const overridesByUid = new Map<string, Map<string, IntermediateEvent>>();
  const standaloneEvents: IntermediateEvent[] = [];

  for (const entry of intermediateEvents) {
    if (entry.hasRrule && !entry.recurrenceId) {
      recurringMastersByUid.set(entry.uid, entry);
      continue;
    }

    if (entry.recurrenceId) {
      const perUid = overridesByUid.get(entry.uid) ?? new Map<string, IntermediateEvent>();
      perUid.set(entry.recurrenceId, entry);
      overridesByUid.set(entry.uid, perUid);
      continue;
    }

    standaloneEvents.push(entry);
  }

  const selectedEvents: IntermediateEvent[] = [];
  for (const entry of standaloneEvents) {
    if (overlapsWindow(entry.startMs, entry.endMs, windowStartMs, windowEndMs)) {
      selectedEvents.push(entry);
    }
  }

  for (const [uid, master] of recurringMastersByUid) {
    const overrides = overridesByUid.get(uid);
    const expanded = expandRecurringMaster(master, windowStartMs, windowEndMs);

    for (const occurrence of expanded) {
      const token = occurrence.recurrenceId;
      const override = token ? overrides?.get(token) : undefined;
      if (override && token) {
        if (overlapsWindow(override.startMs, override.endMs, windowStartMs, windowEndMs)) {
          selectedEvents.push(override);
        }
        overrides?.delete(token);
        continue;
      }

      selectedEvents.push(occurrence);
    }
  }

  for (const overrides of overridesByUid.values()) {
    for (const override of overrides.values()) {
      if (overlapsWindow(override.startMs, override.endMs, windowStartMs, windowEndMs)) {
        selectedEvents.push(override);
      }
    }
  }

  const dedupedById = new Map<string, IntermediateEvent>();
  for (const entry of selectedEvents) {
    const existing = dedupedById.get(entry.event.id);
    if (!existing || getLastModifiedEpoch(entry) >= getLastModifiedEpoch(existing)) {
      dedupedById.set(entry.event.id, entry);
    }
  }

  const ordered = [...dedupedById.values()].sort((a, b) => {
    if (a.startMs !== b.startMs) {
      return a.startMs - b.startMs;
    }
    return a.event.id.localeCompare(b.event.id);
  });

  return {
    fetchedCount: intermediateEvents.length,
    events: ordered.map((entry) => entry.event),
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
