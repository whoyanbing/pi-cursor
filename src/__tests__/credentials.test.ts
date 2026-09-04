import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const originalToken = process.env.CURSOR_ACCESS_TOKEN;
const originalPolicy = process.env.PI_CURSOR_SYSTEM_CREDENTIALS;

function jwt(exp: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${body}.sig`;
}

async function loadCredentials() {
  vi.resetModules();
  return import("../auth/credentials.js");
}

/** Tests share one tmp HOME, so each case starts from a clean auth store. */
function clearAuthStore(): void {
  rmSync(join(homedir(), ".pi", "agent", "auth.json"), { force: true });
}

beforeEach(() => {
  delete process.env.CURSOR_ACCESS_TOKEN;
  delete process.env.PI_CURSOR_SYSTEM_CREDENTIALS;
  clearAuthStore();
});

afterEach(() => {
  if (originalToken === undefined) delete process.env.CURSOR_ACCESS_TOKEN;
  else process.env.CURSOR_ACCESS_TOKEN = originalToken;
  if (originalPolicy === undefined) delete process.env.PI_CURSOR_SYSTEM_CREDENTIALS;
  else process.env.PI_CURSOR_SYSTEM_CREDENTIALS = originalPolicy;
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("resolveCredential cascade", () => {
  it("prefers CURSOR_ACCESS_TOKEN from the environment", async () => {
    process.env.CURSOR_ACCESS_TOKEN = jwt(Math.floor(Date.now() / 1000) + 3600);
    const credentials = await loadCredentials();
    const resolved = await credentials.resolveCredential();
    expect(resolved?.source).toBe("env");
    expect(resolved?.accessToken).toBe(process.env.CURSOR_ACCESS_TOKEN);
    expect(credentials.lastCredentialSource()).toBe("env");
  });

  it("falls back to the pi auth store", async () => {
    const authFile = join(homedir(), ".pi", "agent", "auth.json");
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(
      authFile,
      JSON.stringify({
        cursor: { type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 3600), refresh: "refresh-1" },
      }),
      "utf8",
    );
    const credentials = await loadCredentials();
    const resolved = await credentials.resolveCredential();
    expect(resolved?.source).toBe("pi-oauth");
    expect(resolved?.refreshToken).toBe("refresh-1");
  });

  it("returns null when no source has a token", async () => {
    clearAuthStore();
    process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
    const credentials = await loadCredentials();
    const resolved = await credentials.resolveCredential();
    expect(resolved).toBeNull();
    expect(credentials.lastCredentialSource()).toBe("none");
    expect(await credentials.resolveAccessToken()).toBe("");
  });

  it("caches a fresh token across calls", async () => {
    process.env.CURSOR_ACCESS_TOKEN = jwt(Math.floor(Date.now() / 1000) + 3600);
    const credentials = await loadCredentials();
    const first = await credentials.resolveCredential();
    delete process.env.CURSOR_ACCESS_TOKEN; // cache must serve the second call
    const second = await credentials.resolveCredential();
    expect(second?.accessToken).toBe(first?.accessToken);
    credentials.resetCredentialCache();
    clearAuthStore();
    process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
    expect(await credentials.resolveCredential()).toBeNull();
  });

  it("refreshes an expired pi-oauth token", async () => {
    const authFile = join(homedir(), ".pi", "agent", "auth.json");
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(
      authFile,
      JSON.stringify({
        cursor: { type: "oauth", access: jwt(Math.floor(Date.now() / 1000) - 3600), refresh: "refresh-old" },
      }),
      "utf8",
    );
    const refreshed = jwt(Math.floor(Date.now() / 1000) + 7200);
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: refreshed, refreshToken: "refresh-new" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const credentials = await loadCredentials();
    const resolved = await credentials.resolveCredential();
    expect(resolved?.source).toBe("pi-oauth");
    expect(resolved?.accessToken).toBe(refreshed);
    expect(resolved?.refreshToken).toBe("refresh-new");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("drops credentials when refresh fails on an expired token", async () => {
    const authFile = join(homedir(), ".pi", "agent", "auth.json");
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(
      authFile,
      JSON.stringify({
        cursor: { type: "oauth", access: jwt(Math.floor(Date.now() / 1000) - 7200), refresh: "refresh-bad" },
      }),
      "utf8",
    );
    globalThis.fetch = vi.fn(async () => new Response("invalid_grant", { status: 401 })) as unknown as typeof fetch;

    const credentials = await loadCredentials();
    expect(await credentials.resolveCredential()).toBeNull();
  });

  it("forceRefresh bypasses the cache", async () => {
    const authFile = join(homedir(), ".pi", "agent", "auth.json");
    mkdirSync(join(homedir(), ".pi", "agent"), { recursive: true });
    writeFileSync(
      authFile,
      JSON.stringify({ cursor: { type: "oauth", access: jwt(Math.floor(Date.now() / 1000) + 3600), refresh: "r" } }),
      "utf8",
    );
    const refreshed = jwt(Math.floor(Date.now() / 1000) + 7200);
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: refreshed }), { status: 200 }),
    ) as unknown as typeof fetch;

    const credentials = await loadCredentials();
    await credentials.resolveCredential();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    const forced = await credentials.resolveCredential({ forceRefresh: true });
    expect(forced?.accessToken).toBe(refreshed);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("systemCredentialsAllowed", () => {
  it("is allowed by default", async () => {
    const credentials = await loadCredentials();
    expect(credentials.systemCredentialsAllowed()).toBe(true);
  });

  it("is disabled by PI_CURSOR_SYSTEM_CREDENTIALS=0", async () => {
    process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
    const credentials = await loadCredentials();
    expect(credentials.systemCredentialsAllowed()).toBe(false);
  });
});
