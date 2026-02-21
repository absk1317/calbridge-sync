import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type pino from "pino";
import type { BaseConfig } from "../config.js";
import { requestJson, toFormBody } from "../http.js";
import type { OAuthToken } from "../types.js";
import type { TokenStore } from "./token-store.js";

const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

function redirectUri(config: BaseConfig): string {
  return `http://127.0.0.1:${config.googleOAuthRedirectPort}/oauth2callback`;
}

function tokenEndpoint(): string {
  return "https://oauth2.googleapis.com/token";
}

function buildAuthUrl(config: BaseConfig, state: string): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", config.googleClientId);
  url.searchParams.set("redirect_uri", redirectUri(config));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", state);
  return url.toString();
}

function toStoredToken(response: GoogleTokenResponse, fallbackRefreshToken?: string): OAuthToken {
  const refreshToken = response.refresh_token ?? fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("Google token response missing refresh_token");
  }

  return {
    accessToken: response.access_token,
    refreshToken,
    expiresAt: Date.now() + response.expires_in * 1000 - 60_000,
    scope: response.scope,
    tokenType: response.token_type,
  };
}

export async function authenticateGoogleOAuth(
  config: BaseConfig,
  tokenStore: TokenStore,
  logger: pino.Logger,
): Promise<void> {
  const state = randomBytes(16).toString("hex");
  const authUrl = buildAuthUrl(config, state);

  const code = await waitForOAuthCode(config, state, authUrl, logger);

  const tokenResponse = await requestJson<GoogleTokenResponse>(tokenEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: toFormBody({
      code,
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      redirect_uri: redirectUri(config),
      grant_type: "authorization_code",
    }),
  });

  tokenStore.save("google", toStoredToken(tokenResponse));
  logger.info("Google authentication completed");
}

async function waitForOAuthCode(
  config: BaseConfig,
  expectedState: string,
  authUrl: string,
  logger: pino.Logger,
): Promise<string> {
  logger.info({ authUrl }, "Open this URL to authorize Google access");
  console.log("Open this URL in your browser:");
  console.log(authUrl);

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      if (server.listening) {
        server.close();
      }
      fn();
    };

    const fail = (error: Error) => finish(() => reject(error));
    const succeed = (code: string) => finish(() => resolve(code));

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${config.googleOAuthRedirectPort}`);
      if (url.pathname !== "/oauth2callback") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      if (error) {
        res.statusCode = 400;
        res.end("Authorization failed. You can close this window.");
        fail(new Error(`Google authorization failed: ${error}`));
        return;
      }

      if (!code || state !== expectedState) {
        res.statusCode = 400;
        res.end("Invalid OAuth callback. You can close this window.");
        fail(new Error("Invalid Google OAuth callback state/code"));
        return;
      }

      res.statusCode = 200;
      res.end("Authorization successful. You can close this window.");
      succeed(code);
    });

    server.on("error", (error) => {
      fail(error);
    });

    server.listen(config.googleOAuthRedirectPort, "127.0.0.1");

    const timeoutHandle = setTimeout(() => {
      fail(new Error("Timed out waiting for Google OAuth callback"));
    }, 5 * 60 * 1000);
    timeoutHandle.unref();
  });
}

export async function getGoogleAccessToken(
  config: BaseConfig,
  tokenStore: TokenStore,
): Promise<string> {
  const stored = tokenStore.get("google");
  if (!stored) {
    throw new Error("Google token not found. Run auth:google first.");
  }

  if (stored.expiresAt > Date.now() + 30_000) {
    return stored.accessToken;
  }

  const refreshed = await requestJson<GoogleTokenResponse>(tokenEndpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: toFormBody({
      client_id: config.googleClientId,
      client_secret: config.googleClientSecret,
      refresh_token: stored.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const token = toStoredToken(refreshed, stored.refreshToken);
  tokenStore.save("google", token);
  return token.accessToken;
}
