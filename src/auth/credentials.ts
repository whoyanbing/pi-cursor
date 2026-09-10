/**
 * Credential resolution: `CURSOR_ACCESS_TOKEN` env var, then Pi's OAuth store
 * (~/.pi/agent/auth.json, written by /login cursor). Near-expiry JWTs are
 * refreshed before use when a refresh token is available.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "../config.js";
import { isTokenNearExpiry, refreshAccessToken } from "./oauth.js";

export type CredentialSource = "env" | "pi-oauth" | "none";

export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  source: CredentialSource;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;

let lastSource: CredentialSource = "none";

function authStorePath(): string {
  return join(getAgentDir(), "auth.json");
}

/** Standalone commands share Pi's auth.json lock for the entire refresh.
 * Provider-owned OAuth requests use Pi's own locked CredentialStore instead.
 */
async function refreshPiOAuth(expectedRefresh: string, signal?: AbortSignal): Promise<ResolvedCredential | null> {
  const authPath = authStorePath();
  mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 30_000;
  let release: (() => Promise<void>) | undefined;
  let compromised: Error | undefined;
  while (!release) {
    signal?.throwIfAborted();
    try {
      release = await lockfile.lock(authPath, {
        realpath: false,
        stale: 30_000,
        retries: 0,
        onCompromised: (error) => { compromised = error; },
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      await sleep(50, undefined, { signal });
    }
  }
  try {
    signal?.throwIfAborted();
    if (compromised) throw compromised;
    if (!existsSync(authPath)) return null; // logged out / store removed
    const data = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
    const current = data[PROVIDER_ID] as { type?: string; access?: string; refresh?: string } | undefined;
    if (current?.type !== "oauth" || !current.access) return null;
    // Someone else refreshed or changed accounts while we waited: do not
    // exchange the now-stale token or overwrite their credential.
    if (current.refresh !== expectedRefresh) {
      return { accessToken: current.access, refreshToken: current.refresh, source: "pi-oauth" };
    }
    const refreshed = await refreshAccessToken(expectedRefresh, signal);
    signal?.throwIfAborted();
    if (compromised) throw compromised;
    data[PROVIDER_ID] = { ...current, ...refreshed, type: "oauth" };
    writeFileSync(authPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
    return { accessToken: refreshed.access, refreshToken: refreshed.refresh, source: "pi-oauth" };
  } finally {
    await release();
  }
}

export function lastCredentialSource(): CredentialSource {
  return lastSource;
}

function envToken(): string | undefined {
  const token = process.env.CURSOR_ACCESS_TOKEN?.trim();
  return token || undefined;
}

interface StoredOAuth {
  access?: unknown;
  refresh?: unknown;
}

function piStoredTokens(): { accessToken?: string; refreshToken?: string } {
  try {
    const stored = readStoredCredential(PROVIDER_ID) as StoredOAuth | null;
    if (stored && typeof stored.access === "string" && stored.access.trim()) {
      return {
        accessToken: stored.access.trim(),
        ...(typeof stored.refresh === "string" && stored.refresh.trim() ? { refreshToken: stored.refresh.trim() } : {}),
      };
    }
  } catch {
    // No Pi credential.
  }
  return {};
}

async function readSource(signal?: AbortSignal, skipPiStore = false): Promise<ResolvedCredential | null> {
  signal?.throwIfAborted();
  const env = envToken();
  if (env) return { accessToken: env, source: "env" };

  const stored = skipPiStore ? {} : piStoredTokens();
  if (stored.accessToken) {
    return { accessToken: stored.accessToken, refreshToken: stored.refreshToken, source: "pi-oauth" };
  }

  return null;
}

/** Resolve a usable access token, refreshing near-expiry tokens when possible. */
export async function resolveCredential(options?: {
  forceRefresh?: boolean;
  signal?: AbortSignal;
  /** Native provider auth must not read a different SDK runtime's auth store. */
  skipPiStore?: boolean;
  /** Availability checks may inspect credentials but must not exchange tokens. */
  refresh?: boolean;
}): Promise<ResolvedCredential | null> {
  let credential = await readSource(options?.signal, options?.skipPiStore);
  if (!credential) {
    lastSource = "none";
    return null;
  }

  if (options?.refresh !== false && credential.refreshToken && (options?.forceRefresh || isTokenNearExpiry(credential.accessToken))) {
    try {
      if (credential.source === "pi-oauth") {
        const refreshed = await refreshPiOAuth(credential.refreshToken, options?.signal);
        if (!refreshed) {
          lastSource = "none";
          return null;
        }
        credential = refreshed;
      } else {
        const refreshed = await refreshAccessToken(credential.refreshToken, options?.signal);
        credential = { accessToken: refreshed.access, refreshToken: refreshed.refresh, source: "pi-oauth" };
      }
    } catch {
      options?.signal?.throwIfAborted();
      // Keep the unrefreshed token if it is not actually expired yet.
      if (isTokenNearExpiry(credential.accessToken, -REFRESH_SKEW_MS)) {
        lastSource = "none";
        return null;
      }
    }
  }

  lastSource = credential.source;
  return credential;
}

/** Access token for stream calls; empty string when not logged in. */
export async function resolveAccessToken(signal?: AbortSignal): Promise<string> {
  const credential = await resolveCredential({ signal });
  return credential?.accessToken ?? "";
}

/** Forget the last resolved source (after login/logout or account switches). */
export function resetCredentialCache(): void {
  lastSource = "none";
}
