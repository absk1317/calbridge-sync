export type Provider = "microsoft" | "google";

export interface OAuthToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
  tokenType?: string;
}

export interface TimeWindow {
  startIso: string;
  endIso: string;
}
