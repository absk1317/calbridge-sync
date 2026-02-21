export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;

  constructor(message: string, status: number, body: unknown, headers: Headers) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

function tryParseBody(text: string): unknown {
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function requestJson<T>(
  input: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  const response = await fetch(input, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  const parsed = tryParseBody(text);

  if (!response.ok) {
    throw new HttpError(
      `Request failed with status ${response.status} for ${input}`,
      response.status,
      parsed,
      response.headers,
    );
  }

  return (parsed ?? {}) as T;
}

export function toFormBody(params: Record<string, string>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    body.set(key, value);
  }
  return body.toString();
}

export function isRetriableStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function getRetryDelayMs(error: HttpError, attempt: number): number {
  const retryAfter = error.headers.get("retry-after");
  if (retryAfter) {
    const asNumber = Number(retryAfter);
    if (!Number.isNaN(asNumber)) {
      return Math.max(asNumber * 1_000, 1_000);
    }
  }

  const base = Math.min(1_000 * 2 ** (attempt - 1), 30_000);
  const jitter = Math.floor(Math.random() * 250);
  return base + jitter;
}

export async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
