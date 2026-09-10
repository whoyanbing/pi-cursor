import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import lockfile from "proper-lockfile";
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
  vi.unstubAllEnvs();
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

  it("observes environment changes rather than reusing a stale account", async () => {
    process.env.CURSOR_ACCESS_TOKEN = jwt(Math.floor(Date.now() / 1000) + 3600);
    const credentials = await loadCredentials();
    expect((await credentials.resolveCredential())?.source).toBe("env");
    process.env.CURSOR_ACCESS_TOKEN = "replacement";
    expect((await credentials.resolveCredential())?.accessToken).toBe("replacement");
    delete process.env.CURSOR_ACCESS_TOKEN;
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
    const persisted = JSON.parse(readFileSync(authFile, "utf8")) as {
      cursor: { access: string; refresh: string; expires: number; type: string };
    };
    expect(persisted.cursor.type).toBe("oauth");
    expect(persisted.cursor.access).toBe(refreshed);
    expect(persisted.cursor.refresh).toBe("refresh-new");
    expect(persisted.cursor.expires).toBeGreaterThan(Date.now());
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

describe("OAuth store lifecycle", () => {
  function seed(path: string) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify({
      cursor: { type: "oauth", access: jwt(Math.floor(Date.now() / 1000) - 3600), refresh: "old", expires: 1 },
      other: { type: "api_key", key: "preserve" },
    }));
  }
  function mockRefresh() {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      accessToken: jwt(Math.floor(Date.now() / 1000) + 7200), refreshToken: "new",
    })));
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("writes to PI_CODING_AGENT_DIR without touching the default account", async () => {
    const dir = join(homedir(), "custom-agent");
    const path = join(dir, "auth.json");
    const defaultPath = join(homedir(), ".pi", "agent", "auth.json");
    seed(path);
    writeFileSync(defaultPath, '{"cursor":{"type":"api_key","key":"other-account"}}');
    vi.stubEnv("PI_CODING_AGENT_DIR", dir);
    mockRefresh();
    const credentials = await loadCredentials();
    expect((await credentials.resolveCredential())?.refreshToken).toBe("new");
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ cursor: { refresh: "new" }, other: { key: "preserve" } });
    expect(JSON.parse(readFileSync(defaultPath, "utf8")).cursor.key).toBe("other-account");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("serializes concurrent refreshes so the rotated token is exchanged once", async () => {
    seed(join(homedir(), ".pi", "agent", "auth.json"));
    const fetch = mockRefresh();
    const credentials = await loadCredentials();
    const results = await Promise.all([credentials.resolveCredential(), credentials.resolveCredential()]);
    expect(results.map(value => value?.refreshToken)).toEqual(["new", "new"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rechecks the account under Pi's lock before refreshing", async () => {
    const path = join(homedir(), ".pi", "agent", "auth.json");
    seed(path);
    const release = await lockfile.lock(path, { realpath: false });
    const fetch = mockRefresh();
    const credentials = await loadCredentials();
    const result = credentials.resolveCredential();
    // readSource has captured the old refresh token; switch accounts while the
    // request is waiting for the same lock that Pi's CredentialStore uses.
    await new Promise(resolve => setTimeout(resolve, 20));
    writeFileSync(path, JSON.stringify({ cursor: { type: "oauth", access: "other", refresh: "other-refresh" } }));
    await release();
    expect((await result)?.accessToken).toBe("other");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("can cancel while waiting for the credential lock", async () => {
    const path = join(homedir(), ".pi", "agent", "auth.json");
    seed(path);
    const release = await lockfile.lock(path, { realpath: false });
    try {
      const credentials = await loadCredentials();
      const controller = new AbortController();
      const result = credentials.resolveCredential({ signal: controller.signal });
      const rejected = expect(result).rejects.toThrow(/abort/i);
      controller.abort();
      await rejected;
    } finally { await release(); }
  });

  it("does not refresh during availability checks", async () => {
    seed(join(homedir(), ".pi", "agent", "auth.json"));
    const fetch = mockRefresh();
    const credentials = await loadCredentials();
    expect((await credentials.resolveCredential({ refresh: false }))?.refreshToken).toBe("old");
    expect(fetch).not.toHaveBeenCalled();
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

  it("does not notify when the token came from env or pi-oauth", async () => {
    process.env.CURSOR_ACCESS_TOKEN = jwt(Math.floor(Date.now() / 1000) + 3600);
    const credentials = await loadCredentials();
    await credentials.resolveCredential();
    expect(credentials.consumeSystemCredentialNotice()).toBeUndefined();
  });
});
