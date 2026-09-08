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
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
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
  return join(homedir(), ".pi", "agent", "auth.json");
}

/**
 * Persist a rotated pi-oauth token back to auth.json. Cursor may rotate the
 * refresh token on exchange; keeping only the in-memory copy would invalidate
 * Pi's next `/login`-owned refresh. Keychain / IDE tokens are never written
 * here — those stores belong to the desktop apps.
 */
function persistPiOAuth(access: string, refresh: string, expires: number): void {
  const authPath = authStorePath();
  try {
    mkdirSync(dirname(authPath), { recursive: true, mode: 0o700 });
    let data: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      const parsed = JSON.parse(readFileSync(authPath, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    }
    const current = data[PROVIDER_ID];
    if (current && typeof current === "object" && !Array.isArray(current)) {
      const type = (current as { type?: unknown }).type;
      if (type && type !== "oauth") return;
      data[PROVIDER_ID] = { ...current, type: "oauth", access, refresh, expires };
    } else {
      data[PROVIDER_ID] = { type: "oauth", access, refresh, expires };
    }
    writeFileSync(authPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
  } catch {
    // In-memory token still works for this process.
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

function runSecurity(args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("security", args, { timeout: 5000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      const value = stdout.trim();
      resolve(value || undefined);
    });
  });
}

async function keychainTokens(): Promise<{ accessToken?: string; refreshToken?: string }> {
  if (process.platform !== "darwin") return {};
  const [accessToken, refreshToken] = await Promise.all([
    runSecurity(["find-generic-password", "-s", "cursor-access-token", "-a", "cursor-user", "-w"]),
    runSecurity(["find-generic-password", "-s", "cursor-refresh-token", "-a", "cursor-user", "-w"]),
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

async function readSource(signal?: AbortSignal): Promise<ResolvedCredential | null> {
  const env = envToken();
  if (env) return { accessToken: env, source: "env" };

  const stored = piStoredTokens();
  if (stored.accessToken) {
    return { accessToken: stored.accessToken, refreshToken: stored.refreshToken, source: "pi-oauth" };
  }

  if (!systemCredentialsAllowed()) return null;

  const keychain = await keychainTokens();
  if (keychain.accessToken) {
    return { accessToken: keychain.accessToken, refreshToken: keychain.refreshToken, source: "keychain" };
  }

  const vscdb = await vscdbTokens();
  if (vscdb.accessToken) {
    return { accessToken: vscdb.accessToken, refreshToken: vscdb.refreshToken, source: "ide-vscdb" };
  }

  void signal;
  return null;
}

/** Resolve a usable access token, refreshing near-expiry tokens when possible. */
export async function resolveCredential(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<ResolvedCredential | null> {
  if (!options?.forceRefresh && cached && !isTokenNearExpiry(cached.accessToken)) {
    lastSource = cached.source;
    return { accessToken: cached.accessToken, refreshToken: cached.refreshToken, source: cached.source };
  }

  let credential = await readSource(options?.signal);
  if (!credential) {
    cached = null;
    lastSource = "none";
    return null;
  }

  if (credential.refreshToken && (options?.forceRefresh || isTokenNearExpiry(credential.accessToken))) {
    try {
      const refreshed = await refreshAccessToken(credential.refreshToken, options?.signal);
      credential = { accessToken: refreshed.access, refreshToken: refreshed.refresh, source: credential.source };
      if (credential.source === "pi-oauth") {
        persistPiOAuth(refreshed.access, refreshed.refresh, refreshed.expires);
      }
    } catch {
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
export async function resolveAccessToken(): Promise<string> {
  const credential = await resolveCredential();
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
