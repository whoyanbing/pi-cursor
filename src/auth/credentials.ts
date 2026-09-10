/**
 * Credential resolution cascade.
 *
 *   1. `CURSOR_ACCESS_TOKEN` env var
 *   2. Pi's OAuth store (~/.pi/agent/auth.json, written by /login cursor)
 *   3. macOS Keychain (tokens stored by the Cursor CLI)
 *   4. Cursor IDE local state (globalStorage/state.vscdb)
 *
 * Steps 3–4 reuse credentials from the desktop apps and are gated behind
 * PI_CURSOR_SYSTEM_CREDENTIALS (set to 0 to disable). Access tokens are JWTs;
 * a token within 5 minutes of expiry is refreshed before use when a refresh
 * token is available.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getAgentDir, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "../config.js";
import { isTokenNearExpiry, refreshAccessToken, tokenExpiry } from "./oauth.js";

export type CredentialSource = "env" | "pi-oauth" | "keychain" | "ide-vscdb" | "none";

export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  source: CredentialSource;
}

const REFRESH_SKEW_MS = 5 * 60 * 1000;

let cached: (ResolvedCredential & { expiresAt: number }) | null = null;
let lastSource: CredentialSource = "none";
let systemCredentialNoticeShown = false;

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

export function systemCredentialsAllowed(): boolean {
  return process.env.PI_CURSOR_SYSTEM_CREDENTIALS?.trim() !== "0";
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

function runSecurity(args: string[], signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("security", args, { timeout: 5000, signal }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const value = stdout.trim();
      resolve(value || undefined);
    });
  });
}

async function keychainTokens(signal?: AbortSignal): Promise<{ accessToken?: string; refreshToken?: string }> {
  if (process.platform !== "darwin") return {};
  const [accessToken, refreshToken] = await Promise.all([
    runSecurity(["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"], signal),
    runSecurity(["find-generic-password", "-s", "cursor-refresh-token", "-a", "cursor-user", "-w"], signal),
  ]);
  return { ...(accessToken ? { accessToken } : {}), ...(refreshToken ? { refreshToken } : {}) };
}

function vscdbPaths(): string[] {
  const home = homedir();
  if (process.platform === "darwin") {
    return [join(home, "Library/Application Support/Cursor/User/globalStorage/state.vscdb")];
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    return appData ? [join(appData, "Cursor/User/globalStorage/state.vscdb")] : [];
  }
  return [join(home, ".config/Cursor/User/globalStorage/state.vscdb")];
}

async function vscdbTokens(): Promise<{ accessToken?: string; refreshToken?: string }> {
  for (const path of vscdbPaths()) {
    try {
      if (!existsSync(path)) continue;
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const access = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken'")
          .get() as { value?: unknown } | undefined;
        const refresh = db
          .prepare("SELECT value FROM ItemTable WHERE key = 'cursorAuth/refreshToken'")
          .get() as { value?: unknown } | undefined;
        const accessToken = typeof access?.value === "string" ? access.value.trim() : "";
        const refreshToken = typeof refresh?.value === "string" ? refresh.value.trim() : "";
        if (accessToken) {
          return { accessToken, ...(refreshToken ? { refreshToken } : {}) };
        }
      } finally {
        db.close();
      }
    } catch {
      // Locked, missing table, or no sqlite support — try the next source.
    }
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

  if (!systemCredentialsAllowed()) return null;

  // Cache only desktop credentials. Pi's store and environment must be read
  // on every call so logout, account changes, and policy changes take effect.
  if (cached && (cached.source === "keychain" || cached.source === "ide-vscdb") && Date.now() < cached.expiresAt) {
    return cached;
  }
  const keychain = await keychainTokens(signal);
  signal?.throwIfAborted();
  if (keychain.accessToken) {
    return { accessToken: keychain.accessToken, refreshToken: keychain.refreshToken, source: "keychain" };
  }

  const vscdb = await vscdbTokens();
  signal?.throwIfAborted();
  if (vscdb.accessToken) {
    return { accessToken: vscdb.accessToken, refreshToken: vscdb.refreshToken, source: "ide-vscdb" };
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
    cached = null;
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
        credential = { accessToken: refreshed.access, refreshToken: refreshed.refresh, source: credential.source };
      }
    } catch {
      options?.signal?.throwIfAborted();
      // Keep the unrefreshed token if it is not actually expired yet.
      if (isTokenNearExpiry(credential.accessToken, -REFRESH_SKEW_MS)) {
        cached = null;
        lastSource = "none";
        return null;
      }
    }
  }

  cached = { ...credential, expiresAt: tokenExpiry(credential.accessToken) };
  lastSource = credential.source;
  return credential;
}

/** Access token for stream calls; empty string when not logged in. */
export async function resolveAccessToken(signal?: AbortSignal): Promise<string> {
  const credential = await resolveCredential({ signal });
  return credential?.accessToken ?? "";
}

/** One-shot notice when we reused desktop-app credentials. */
export function consumeSystemCredentialNotice(): string | undefined {
  if (systemCredentialNoticeShown) return undefined;
  if (lastSource !== "keychain" && lastSource !== "ide-vscdb") return undefined;
  systemCredentialNoticeShown = true;
  const where = lastSource === "keychain" ? "the macOS Keychain" : "Cursor IDE local state";
  return `Using Cursor credentials from ${where}. Run /login cursor for a Pi-owned login, or set PI_CURSOR_SYSTEM_CREDENTIALS=0 to disable reuse.`;
}

/** Drop the in-memory cache (after login/logout or account switches). */
export function resetCredentialCache(): void {
  cached = null;
  lastSource = "none";
  systemCredentialNoticeShown = false;
}
