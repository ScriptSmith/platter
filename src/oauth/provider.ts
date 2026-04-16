import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import type { PlatterClientsStore } from "./clients-store.js";

// TTLs
const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const PENDING_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SWEEP_INTERVAL_MS = 60_000;

interface CodeEntry {
  clientId: string;
  params: AuthorizationParams;
  grantedScopes: string[];
  createdAt: number;
}

interface TokenEntry {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface RefreshEntry {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: URL;
}

interface PendingEntry {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  confirmationCode: string;
  attempts: number;
  createdAt: number;
}

export interface PendingAuthEvent {
  requestId: string;
  clientName: string;
  confirmationCode: string;
}

const CONFIRMATION_CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I/L
const CONFIRMATION_CODE_LENGTH = 6;
const MAX_CONFIRMATION_ATTEMPTS = 5;

function generateConfirmationCode(): string {
  const bytes = crypto.randomBytes(CONFIRMATION_CODE_LENGTH);
  return Array.from(bytes, (b) => CONFIRMATION_CODE_CHARS[b % CONFIRMATION_CODE_CHARS.length]).join("");
}

export class PlatterOAuthProvider extends EventEmitter implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;

  private codes = new Map<string, CodeEntry>();
  private tokens = new Map<string, TokenEntry>();
  private refreshTokens = new Map<string, RefreshEntry>();
  private pending = new Map<string, PendingEntry>();
  private sweeper: NodeJS.Timeout;

  constructor(store: PlatterClientsStore) {
    super();
    this.clientsStore = store;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  dispose(): void {
    clearInterval(this.sweeper);
  }

  // ── OAuthServerProvider ───────────────────────────────────────────

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const requestId = crypto.randomBytes(16).toString("base64url");
    const confirmationCode = generateConfirmationCode();
    this.pending.set(requestId, { client, params, confirmationCode, attempts: 0, createdAt: Date.now() });

    const clientName = client.client_name || client.client_id;
    this.emit("pending", { requestId, clientName, confirmationCode } satisfies PendingAuthEvent);

    res.redirect(`/oauth/consent?request_id=${encodeURIComponent(requestId)}`);
  }

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code");
    return entry.params.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const entry = this.codes.get(authorizationCode);
    if (!entry) throw new Error("Invalid authorization code");
    if (entry.clientId !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    if (Date.now() - entry.createdAt > CODE_TTL_MS) {
      this.codes.delete(authorizationCode);
      throw new Error("Authorization code has expired");
    }
    this.codes.delete(authorizationCode);

    const accessToken = crypto.randomBytes(32).toString("base64url");
    const refreshToken = crypto.randomBytes(32).toString("base64url");
    const scopes = entry.grantedScopes;

    this.tokens.set(accessToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: entry.params.resource,
    });

    this.refreshTokens.set(refreshToken, {
      clientId: client.client_id,
      scopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: entry.params.resource,
    });

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const entry = this.refreshTokens.get(refreshToken);
    if (!entry) throw new Error("Invalid refresh token");
    if (entry.clientId !== client.client_id) {
      throw new Error("Refresh token was not issued to this client");
    }
    if (Date.now() > entry.expiresAt) {
      this.refreshTokens.delete(refreshToken);
      throw new Error("Refresh token has expired");
    }

    // Revoke old refresh token (rotation).
    this.refreshTokens.delete(refreshToken);

    const newScopes = scopes ?? entry.scopes;
    const newAccessToken = crypto.randomBytes(32).toString("base64url");
    const newRefreshToken = crypto.randomBytes(32).toString("base64url");

    this.tokens.set(newAccessToken, {
      clientId: client.client_id,
      scopes: newScopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      resource: entry.resource,
    });

    this.refreshTokens.set(newRefreshToken, {
      clientId: client.client_id,
      scopes: newScopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      resource: entry.resource,
    });

    return {
      access_token: newAccessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_MS / 1000,
      refresh_token: newRefreshToken,
      scope: newScopes.join(" "),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const entry = this.tokens.get(token);
    if (!entry) throw new Error("Invalid access token");
    if (Date.now() > entry.expiresAt) {
      this.tokens.delete(token);
      throw new Error("Access token has expired");
    }
    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: Math.floor(entry.expiresAt / 1000),
      resource: entry.resource,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const { token, token_type_hint } = request;
    if (token_type_hint === "refresh_token") {
      this.refreshTokens.delete(token);
    } else if (token_type_hint === "access_token") {
      this.tokens.delete(token);
    } else {
      // Try both.
      this.tokens.delete(token);
      this.refreshTokens.delete(token);
    }
  }

  // ── Consent helpers (called by consent route handlers) ────────────

  getPending(requestId: string): PendingEntry | undefined {
    const entry = this.pending.get(requestId);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > PENDING_TTL_MS) {
      this.pending.delete(requestId);
      return undefined;
    }
    return entry;
  }

  /**
   * Approve a pending authorization. Validates the confirmation code that was
   * displayed out-of-band (tray notification / stderr). `grantedScopes` are
   * the scopes the user selected on the consent page. Returns the redirect URL.
   *
   * Throws `"Invalid confirmation code"` on mismatch (the pending entry is
   * preserved so the user can retry, up to MAX_CONFIRMATION_ATTEMPTS).
   */
  approveAuthorization(requestId: string, confirmationCode: string, grantedScopes: string[]): string {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error("Authorization request not found or expired");

    if (entry.attempts >= MAX_CONFIRMATION_ATTEMPTS) {
      this.pending.delete(requestId);
      throw new Error("Too many failed attempts");
    }

    if (confirmationCode.toUpperCase() !== entry.confirmationCode) {
      entry.attempts++;
      throw new Error("Invalid confirmation code");
    }

    this.pending.delete(requestId);

    const code = crypto.randomBytes(32).toString("base64url");
    this.codes.set(code, {
      clientId: entry.client.client_id,
      params: entry.params,
      grantedScopes,
      createdAt: Date.now(),
    });

    const target = new URL(entry.params.redirectUri);
    target.searchParams.set("code", code);
    if (entry.params.state) target.searchParams.set("state", entry.params.state);
    return target.toString();
  }

  /**
   * Deny a pending authorization. Returns the redirect URL with an error.
   */
  denyAuthorization(requestId: string): string {
    const entry = this.pending.get(requestId);
    if (!entry) throw new Error("Authorization request not found or expired");
    this.pending.delete(requestId);

    const target = new URL(entry.params.redirectUri);
    target.searchParams.set("error", "access_denied");
    target.searchParams.set("error_description", "The user denied the authorization request");
    if (entry.params.state) target.searchParams.set("state", entry.params.state);
    return target.toString();
  }

  // ── Sweep expired state ───────────────────────────────────────────

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.codes) {
      if (now - v.createdAt > CODE_TTL_MS) this.codes.delete(k);
    }
    for (const [k, v] of this.tokens) {
      if (now > v.expiresAt) this.tokens.delete(k);
    }
    for (const [k, v] of this.refreshTokens) {
      if (now > v.expiresAt) this.refreshTokens.delete(k);
    }
    for (const [k, v] of this.pending) {
      if (now - v.createdAt > PENDING_TTL_MS) this.pending.delete(k);
    }
  }
}
