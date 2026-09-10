/**
 * Cursor OAuth via PKCE.
 *
 *   1. generate verifier + challenge
 *   2. hand Pi the loginDeepControl URL (browser opens, user approves)
 *   3. poll api2.cursor.sh/auth/poll until tokens arrive
 *   4. refresh via api2.cursor.sh/auth/exchange_user_api_key
 */
import { LOGIN_URL, POLL_URL, REFRESH_URL } from "../config.js";

export interface CursorCredentials {
  access: string;
  refresh: string;
  expires: number;
}

export interface LoginCallbacks {
  onAuth(payload: { url: string }): void | Promise<void>;
}

const POLL_MAX_ATTEMPTS = 150;
const POLL_BASE_DELAY_MS = 1000;
const POLL_MAX_DELAY_MS = 10_000;
const POLL_BACKOFF = 1.2;
const REQUEST_TIMEOUT_MS = 15_000;

/** Test hook: shrink (or restore) the poll backoff so suites do not wait for real seconds. */
let pollDelayScale = 1;
export function setPollDelayScaleForTests(scale: number): void {
  pollDelayScale = scale;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Cursor login aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("Cursor login aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(96);
  crypto.getRandomValues(verifierBytes);
  const verifier = Buffer.from(verifierBytes).toString("base64url");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(digest).toString("base64url");
  return { verifier, challenge };
}

export interface LoginParams {
  verifier: string;
  uuid: string;
  loginUrl: string;
}

export async function generateLoginParams(): Promise<LoginParams> {
  const { verifier, challenge } = await generatePkce();
  const uuid = crypto.randomUUID();
  const params = new URLSearchParams({ challenge, uuid, mode: "login", redirectTarget: "cli" });
  return { verifier, uuid, loginUrl: `${LOGIN_URL}?${params.toString()}` };
}

function parseTokenResponse(value: unknown, endpoint: string): { accessToken: string; refreshToken?: string } {
  if (!value || typeof value !== "object") throw new Error(`${endpoint} returned an invalid token response`);
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken !== "string" || !record.accessToken.trim()) {
    throw new Error(`${endpoint} returned no access token`);
  }
  if (record.refreshToken !== undefined && typeof record.refreshToken !== "string") {
    throw new Error(`${endpoint} returned an invalid refresh token`);
  }
  return {
    accessToken: record.accessToken,
    ...(typeof record.refreshToken === "string" ? { refreshToken: record.refreshToken } : {}),
  };
}

/** Poll until the browser login completes (404 = still pending). */
export async function pollForTokens(
  uuid: string,
  verifier: string,
  signal?: AbortSignal,
): Promise<{ accessToken: string; refreshToken: string }> {
  let delay = POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt += 1) {
    await sleep(Math.round(delay * pollDelayScale), signal);
    try {
      const poll = new URL(POLL_URL);
      poll.searchParams.set("uuid", uuid);
      poll.searchParams.set("verifier", verifier);
      const response = await fetch(poll.toString(), {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 404) {
        consecutiveErrors = 0;
        delay = Math.min(delay * POLL_BACKOFF, POLL_MAX_DELAY_MS);
        continue;
      }
      if (response.ok) {
        const data = parseTokenResponse(await response.json(), "Cursor login polling");
        if (!data.refreshToken) throw new Error("Cursor login polling returned no refresh token");
        return { accessToken: data.accessToken, refreshToken: data.refreshToken };
      }
      throw new Error(`Cursor login poll failed: HTTP ${response.status}`);
    } catch (error) {
      if (signal?.aborted) throw new Error("Cursor login aborted");
      consecutiveErrors += 1;
      if (consecutiveErrors >= 3) {
        throw new Error(`Too many consecutive errors during Cursor login polling: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  throw new Error("Cursor login polling timed out — restart /login cursor and complete the browser step");
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshAccessToken(refreshToken: string, signal?: AbortSignal): Promise<CursorCredentials> {
  const response = await fetch(REFRESH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${refreshToken}`, "Content-Type": "application/json" },
    body: "{}",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Cursor token refresh failed: HTTP ${response.status} ${detail}`);
  }
  const data = parseTokenResponse(await response.json(), "Cursor token refresh");
  return {
    access: data.accessToken,
    refresh: data.refreshToken || refreshToken,
    expires: tokenExpiry(data.accessToken),
  };
}

/** Full login flow for Pi's oauth callback. */
export async function loginCursor(callbacks: LoginCallbacks, signal?: AbortSignal): Promise<CursorCredentials> {
  signal?.throwIfAborted();
  const params = await generateLoginParams();
  signal?.throwIfAborted();
  await callbacks.onAuth({ url: params.loginUrl });
  const tokens = await pollForTokens(params.uuid, params.verifier, signal);
  signal?.throwIfAborted();
  return { access: tokens.accessToken, refresh: tokens.refreshToken, expires: tokenExpiry(tokens.accessToken) };
}

/**
 * Access-token expiry from the JWT `exp` claim, minus a 5-minute skew so
 * refresh happens before the token actually dies. Falls back to +1h.
 */
export function tokenExpiry(token: string): number {
  try {
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      const decoded = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as {
        exp?: number;
      };
      if (decoded && typeof decoded.exp === "number") return decoded.exp * 1000 - 5 * 60 * 1000;
    }
  } catch {
    // Opaque token; fall through.
  }
  return Date.now() + 60 * 60 * 1000;
}

export function isTokenNearExpiry(token: string, skewMs = 0): boolean {
  return tokenExpiry(token) - skewMs <= Date.now();
}
