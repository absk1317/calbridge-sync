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
}

interface GoogleCalendar {
  id: string;
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
