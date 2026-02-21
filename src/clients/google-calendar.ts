import type pino from "pino";
import { HttpError, requestJson } from "../http.js";
import { withRetry } from "../retry.js";

export interface GoogleEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface GoogleEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  reminders?: {
    useDefault: boolean;
    overrides?: Array<{ method: "popup"; minutes: number }>;
  };
  extendedProperties: {
    private: Record<string, string>;
  };
}

export interface GoogleEvent {
  id: string;
  etag?: string;
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

interface GoogleCalendar {
  id: string;
}

interface GoogleEventListPage {
  items?: GoogleEvent[];
  nextPageToken?: string;
}

export interface GoogleSourceEvent {
  id?: string;
  iCalUID?: string;
  recurringEventId?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  updated?: string;
  start?: GoogleEventDateTime;
  end?: GoogleEventDateTime;
  reminders?: {
    useDefault?: boolean;
    overrides?: Array<{ method?: string; minutes?: number }>;
  };
}

interface GoogleSourceEventListPage {
  items?: GoogleSourceEvent[];
  nextPageToken?: string;
}

export class GoogleCalendarClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly logger: pino.Logger,
  ) {}

  async createEvent(calendarId: string, event: GoogleEventInput): Promise<GoogleEvent> {
    const encodedCalendarId = encodeURIComponent(calendarId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events?sendUpdates=none`;
    return this.request<GoogleEvent>(url, "POST", event, "google_create_event");
  }

  async updateEvent(
    calendarId: string,
    eventId: string,
    event: GoogleEventInput,
  ): Promise<GoogleEvent> {
    const encodedCalendarId = encodeURIComponent(calendarId);
    const encodedEventId = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}?sendUpdates=none`;
    return this.request<GoogleEvent>(url, "PUT", event, "google_update_event");
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<boolean> {
    const encodedCalendarId = encodeURIComponent(calendarId);
    const encodedEventId = encodeURIComponent(eventId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events/${encodedEventId}?sendUpdates=none`;

    try {
      await this.request<void>(url, "DELETE", undefined, "google_delete_event");
      return true;
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        return false;
      }
      throw error;
    }
  }

  async healthCheck(calendarId: string): Promise<void> {
    const encodedCalendarId = encodeURIComponent(calendarId);
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}`;
    await this.request<GoogleCalendar>(url, "GET", undefined, "google_health");
  }

  async listEventsByPrivateExtendedProperties(
    calendarId: string,
    filters: Record<string, string>,
  ): Promise<GoogleEvent[]> {
    const encodedCalendarId = encodeURIComponent(calendarId);
    const results: GoogleEvent[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events`,
      );
      url.searchParams.set("maxResults", "2500");
      url.searchParams.set("showDeleted", "false");
      url.searchParams.set("singleEvents", "false");
      url.searchParams.set("fields", "items(id,etag,extendedProperties),nextPageToken");
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }
      for (const [key, value] of Object.entries(filters)) {
        url.searchParams.append("privateExtendedProperty", `${key}=${value}`);
      }

      const page = await this.request<GoogleEventListPage>(
        url.toString(),
        "GET",
        undefined,
        "google_list_events_by_private_extended_properties",
      );
      results.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    return results;
  }

  async listCalendarView(calendarId: string, startIso: string, endIso: string): Promise<GoogleSourceEvent[]> {
    const encodedCalendarId = encodeURIComponent(calendarId);
    const results: GoogleSourceEvent[] = [];
    let pageToken: string | undefined;

    do {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodedCalendarId}/events`,
      );
      url.searchParams.set("timeMin", startIso);
      url.searchParams.set("timeMax", endIso);
      url.searchParams.set("maxResults", "2500");
      url.searchParams.set("singleEvents", "true");
      url.searchParams.set("showDeleted", "true");
      url.searchParams.set("orderBy", "startTime");
      url.searchParams.set("timeZone", "UTC");
      url.searchParams.set(
        "fields",
        "items(id,iCalUID,recurringEventId,summary,description,location,status,updated,start,end,reminders),nextPageToken",
      );
      if (pageToken) {
        url.searchParams.set("pageToken", pageToken);
      }

      const page = await this.request<GoogleSourceEventListPage>(
        url.toString(),
        "GET",
        undefined,
        "google_list_calendar_view",
      );
      results.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);

    return results;
  }

  private async request<T>(
    url: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body: unknown,
    operationName: string,
  ): Promise<T> {
    return withRetry(this.logger, operationName, async () => {
      const token = await this.getAccessToken();
      return requestJson<T>(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    });
  }
}
