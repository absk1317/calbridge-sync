import type pino from "pino";
import { requestJson } from "../http.js";
import { withRetry } from "../retry.js";

export interface GraphDateTimeTimeZone {
  dateTime: string;
  timeZone: string;
}

export interface GraphBody {
  contentType: "text" | "html";
  content: string;
}

export interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: GraphBody;
  location?: {
    displayName?: string;
  };
  start?: GraphDateTimeTimeZone;
  end?: GraphDateTimeTimeZone;
  isAllDay?: boolean;
  isCancelled?: boolean;
  lastModifiedDateTime?: string;
  sensitivity?: string;
  reminderMinutesBeforeStart?: number;
  type?: string;
  seriesMasterId?: string;
}

interface GraphPage {
  value: GraphEvent[];
  "@odata.nextLink"?: string;
}

export class MicrosoftGraphClient {
  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly logger: pino.Logger,
  ) {}

  async listCalendarView(startIso: string, endIso: string): Promise<GraphEvent[]> {
    const baseUrl = new URL("https://graph.microsoft.com/v1.0/me/calendarView");
    baseUrl.searchParams.set("startDateTime", startIso);
    baseUrl.searchParams.set("endDateTime", endIso);
    baseUrl.searchParams.set("$top", "1000");
    baseUrl.searchParams.set(
      "$select",
      [
        "id",
        "iCalUId",
        "subject",
        "bodyPreview",
        "body",
        "location",
        "start",
        "end",
        "isAllDay",
        "isCancelled",
        "lastModifiedDateTime",
        "sensitivity",
        "reminderMinutesBeforeStart",
        "type",
        "seriesMasterId",
      ].join(","),
    );

    const events: GraphEvent[] = [];
    let nextUrl: string | undefined = baseUrl.toString();

    while (nextUrl) {
      const page: GraphPage = await this.request(nextUrl, "graph_calendar_view");
      events.push(...page.value);
      nextUrl = page["@odata.nextLink"];
    }

    return events;
  }

  async healthCheck(): Promise<void> {
    await this.request<{ id: string }>(
      "https://graph.microsoft.com/v1.0/me?$select=id,userPrincipalName",
      "graph_health",
    );
  }

  private async request<T>(url: string, operationName: string): Promise<T> {
    return withRetry(this.logger, operationName, async () => {
      const token = await this.getAccessToken();
      return requestJson<T>(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Prefer: 'outlook.timezone="UTC"',
        },
      });
    });
  }
}
