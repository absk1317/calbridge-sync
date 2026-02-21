import type pino from "pino";
import type { BaseConfig } from "../config.js";
import { HttpError, requestJson, toFormBody, wait } from "../http.js";
import type { OAuthToken } from "../types.js";
import type { TokenStore } from "./token-store.js";

const MICROSOFT_SCOPES = ["offline_access", "https://graph.microsoft.com/Calendars.Read"];

interface DeviceCodeResponse {
  user_code: string;
  device_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
  message: string;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type?: string;
}

interface OAuthErrorResponse {
  error: string;
  error_description?: string;
}

function formatErrorBody(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}

function tokenEndpoint(config: BaseConfig): string {
  return `https://login.microsoftonline.com/${config.microsoftTenantId}/oauth2/v2.0/token`;
}

function deviceCodeEndpoint(config: BaseConfig): string {
  return `https://login.microsoftonline.com/${config.microsoftTenantId}/oauth2/v2.0/devicecode`;
}

function toStoredToken(response: OAuthTokenResponse, fallbackRefreshToken?: string): OAuthToken {
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("Microsoft token response missing refresh_token");
  }

  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000 - 60_000,
    scope: response.scope,
    tokenType: response.token_type,
  };
}

export async function authenticateMicrosoftDeviceCode(
  config: BaseConfig,
  tokenStore: TokenStore,
  logger: pino.Logger,
): Promise<void> {
  const scope = MICROSOFT_SCOPES.join(" ");

  let deviceCode: DeviceCodeResponse;
  try {
    deviceCode = await requestJson<DeviceCodeResponse>(deviceCodeEndpoint(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: toFormBody({
        client_id: config.microsoftClientId,
        scope,
      }),
    });
  } catch (error) {
    if (!(error instanceof HttpError)) {
      throw error;
    }

    const payload = (error.body ?? {}) as Partial<OAuthErrorResponse>;
    const hints = [
      "Microsoft device-code setup check failed.",
      `Tenant endpoint: ${deviceCodeEndpoint(config)}`,
      payload.error ? `AAD error: ${payload.error}` : undefined,
      payload.error_description ? `AAD description: ${payload.error_description}` : undefined,
      "",
      "Checklist:",
      "- Set MICROSOFT_TENANT_ID to your tenant ID (not 'common') for a single-tenant app.",
      "- Azure Portal -> App registration -> Authentication -> Allow public client flows = Yes.",
      "- Azure Portal -> API permissions -> Microsoft Graph delegated permission Calendars.Read.",
      "- Grant admin consent if your tenant requires it.",
      "",
      `Raw response body: ${formatErrorBody(error.body)}`,
    ]
      .filter(Boolean)
      .join("\n");

    throw new Error(hints);
  }

  console.log(deviceCode.message);
  logger.info(
    {
      verificationUri: deviceCode.verification_uri,
      userCode: deviceCode.user_code,
      expiresIn: deviceCode.expires_in,
    },
    "Microsoft device code issued",
  );

  const deadline = Date.now() + deviceCode.expires_in * 1000;
  let pollDelayMs = Math.max(deviceCode.interval, 5) * 1000;

  while (Date.now() < deadline) {
    try {
      const tokenResponse = await requestJson<OAuthTokenResponse>(tokenEndpoint(config), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: toFormBody({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: config.microsoftClientId,
          device_code: deviceCode.device_code,
        }),
      });

      tokenStore.save("microsoft", toStoredToken(tokenResponse));
      logger.info("Microsoft authentication completed");
      return;
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 400) {
        throw error;
      }

      const payload = error.body as Partial<OAuthErrorResponse>;
      if (payload.error === "authorization_pending") {
        await wait(pollDelayMs);
        continue;
      }
      if (payload.error === "slow_down") {
        pollDelayMs += 5_000;
        await wait(pollDelayMs);
        continue;
      }
      if (payload.error === "authorization_declined") {
        throw new Error("Microsoft authorization was declined by user");
      }
      if (payload.error === "expired_token") {
        throw new Error("Microsoft device code flow expired before completion");
      }

      throw error;
    }
  }

  throw new Error("Microsoft device code flow timed out");
}

export async function getMicrosoftAccessToken(
  config: BaseConfig,
  tokenStore: TokenStore,
): Promise<string> {
  const stored = tokenStore.get("microsoft");
  if (!stored) {
    throw new Error("Microsoft token not found. Run auth:microsoft first.");
  }

  if (stored.expiresAt > Date.now() + 30_000) {
    return stored.accessToken;
  }

  const refreshed = await requestJson<OAuthTokenResponse>(tokenEndpoint(config), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: toFormBody({
      grant_type: "refresh_token",
      client_id: config.microsoftClientId,
      refresh_token: stored.refreshToken,
      scope: MICROSOFT_SCOPES.join(" "),
    }),
  });

  const token = toStoredToken(refreshed, stored.refreshToken);
  tokenStore.save("microsoft", token);
  return token.accessToken;
}
