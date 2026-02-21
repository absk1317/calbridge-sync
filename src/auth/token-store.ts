import type pino from "pino";
import { decryptText, encryptText } from "../crypto.js";
import type { DbClient } from "../db.js";
import type { OAuthToken, Provider } from "../types.js";

export class TokenStore {
  constructor(
    private readonly db: DbClient,
    private readonly encryptionKey: string,
    private readonly logger: pino.Logger,
  ) {}

  get(provider: Provider): OAuthToken | undefined {
    const row = this.db.getToken(provider);
    if (!row) {
      return undefined;
    }

    try {
      return {
        accessToken: decryptText(row.access_token, this.encryptionKey),
        refreshToken: decryptText(row.refresh_token, this.encryptionKey),
        expiresAt: row.expiry_ts,
        scope: row.scopes ?? undefined,
      };
    } catch (error) {
      this.logger.error({ provider, err: error }, "Failed to decrypt token from storage");
      throw new Error(`Unable to decrypt stored ${provider} token. Check TOKEN_ENCRYPTION_KEY.`);
    }
  }

  save(provider: Provider, token: OAuthToken) {
    this.db.upsertToken({
      provider,
      access_token: encryptText(token.accessToken, this.encryptionKey),
      refresh_token: encryptText(token.refreshToken, this.encryptionKey),
      expiry_ts: token.expiresAt,
      scopes: token.scope ?? null,
      updated_at: new Date().toISOString(),
    });
  }
}
