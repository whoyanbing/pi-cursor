import { afterEach, describe, expect, it, vi } from "vitest";
import {
  generateLoginParams,
  isTokenNearExpiry,
  loginCursor,
  pollForTokens,
  refreshAccessToken,
  setPollDelayScaleForTests,
  tokenExpiry,
} from "../auth/oauth.js";
import { LOGIN_URL, POLL_URL, REFRESH_URL } from "../config.js";

setPollDelayScaleForTests(0.001);

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("tokenExpiry", () => {
  it("reads exp from a JWT and applies a 5 minute skew", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(tokenExpiry(jwt({ exp }))).toBe(exp * 1000 - 300_000);
  });

  it("falls back to +1h for opaque tokens", () => {
    const before = Date.now();
    const expiry = tokenExpiry("not-a-jwt");
    expect(expiry).toBeGreaterThanOrEqual(before + 3600_000 - 5);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 3600_000);
  });

  it("falls back when exp is missing", () => {
    expect(tokenExpiry(jwt({ sub: "x" }))).toBeGreaterThan(Date.now());
  });

  it("falls back when the payload is not JSON", () => {
    expect(tokenExpiry("a.b.c")).toBeGreaterThan(Date.now());
  });
});

describe("isTokenNearExpiry", () => {
  it("is false for a fresh token", () => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(isTokenNearExpiry(token)).toBe(false);
  });

  it("is true for an expired token", () => {
    const token = jwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    expect(isTokenNearExpiry(token)).toBe(true);
  });

  it("honours the skew window", () => {
    // exp is 40 minutes out; tokenExpiry already subtracts 5, leaving 35 minutes.
    const token = jwt({ exp: Math.floor(Date.now() / 1000) + 2400 });
    expect(isTokenNearExpiry(token, 0)).toBe(false);
    expect(isTokenNearExpiry(token, 60 * 60 * 1000)).toBe(true);
  });
});

describe("generateLoginParams", () => {
  it("builds a loginDeepControl URL with PKCE params", async () => {
    const params = await generateLoginParams();
    expect(params.loginUrl.startsWith(`${LOGIN_URL}?`)).toBe(true);
    const url = new URL(params.loginUrl);
    expect(url.searchParams.get("mode")).toBe("login");
    expect(url.searchParams.get("redirectTarget")).toBe("cli");
    expect(url.searchParams.get("uuid")).toBe(params.uuid);
    expect(url.searchParams.get("challenge")).toBeTruthy();
    expect(params.verifier.length).toBeGreaterThan(40);
  });

  it("derives the challenge from the verifier (S256)", async () => {
    const params = await generateLoginParams();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(params.verifier));
    expect(Buffer.from(digest).toString("base64url")).toBe(new URL(params.loginUrl).searchParams.get("challenge"));
  });

  it("produces unique verifiers", async () => {
    const a = await generateLoginParams();
    const b = await generateLoginParams();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.uuid).not.toBe(b.uuid);
  });
});

describe("pollForTokens", () => {
  it("returns tokens on the first successful poll", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accessToken: jwt({ exp: 9999999999 }), refreshToken: "refresh-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    const tokens = await pollForTokens("uuid-1", "verifier-1");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(tokens.accessToken.split(".")).toHaveLength(3);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      `${POLL_URL}?uuid=uuid-1&verifier=verifier-1`,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("keeps polling through 404s", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls < 3) return new Response("pending", { status: 404 });
      return new Response(JSON.stringify({ accessToken: jwt({}), refreshToken: "r" }), { status: 200 });
    }) as unknown as typeof fetch;

    const tokens = await pollForTokens("u", "v");
    expect(tokens.refreshToken).toBe("r");
    expect(calls).toBe(3);
  });

  it("rejects when the response has no refresh token", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: jwt({}) }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(pollForTokens("u", "v")).rejects.toThrow(/no refresh token/);
  });

  it("rejects on an invalid token response", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;
    await expect(pollForTokens("u", "v")).rejects.toThrow(/no access token/);
  });

  it("gives up after repeated errors", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(pollForTokens("u", "v")).rejects.toThrow(/Too many consecutive errors/);
  });

  it("fails on a non-404 HTTP error after retries", async () => {
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(pollForTokens("u", "v")).rejects.toThrow(/Too many consecutive errors/);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await expect(pollForTokens("u", "v", controller.signal)).rejects.toThrow(/aborted/i);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe("refreshAccessToken", () => {
  it("exchanges a refresh token for new credentials", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: jwt({ exp }), refreshToken: "new-refresh" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const credentials = await refreshAccessToken("old-refresh");
    expect(credentials.refresh).toBe("new-refresh");
    expect(credentials.expires).toBe(exp * 1000 - 300_000);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(REFRESH_URL);
    expect(init).toMatchObject({ method: "POST", body: "{}" });
    expect((init as RequestInit).headers).toEqual(
      expect.objectContaining({ Authorization: "Bearer old-refresh", "Content-Type": "application/json" }),
    );
  });

  it("keeps the old refresh token when the server omits a new one", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ accessToken: jwt({}) }), { status: 200 }),
    ) as unknown as typeof fetch;
    const credentials = await refreshAccessToken("keep-me");
    expect(credentials.refresh).toBe("keep-me");
  });

  it("reports HTTP failures with the status", async () => {
    globalThis.fetch = vi.fn(async () => new Response("invalid_grant", { status: 401 })) as unknown as typeof fetch;
    await expect(refreshAccessToken("bad")).rejects.toThrow(/HTTP 401/);
  });
});

describe("loginCursor", () => {
  it("hands Pi the login URL then polls for tokens", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accessToken: jwt({ exp: 9999999999 }), refreshToken: "refresh-x" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const seen: string[] = [];
    const credentials = await loginCursor({
      onAuth: ({ url }) => {
        seen.push(url);
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].startsWith(LOGIN_URL)).toBe(true);
    expect(credentials.access.split(".")).toHaveLength(3);
    expect(credentials.refresh).toBe("refresh-x");
    expect(credentials.expires).toBeGreaterThan(Date.now());
  });

  it("awaits an async onAuth callback before polling", async () => {
    const order: string[] = [];
    globalThis.fetch = vi.fn(async () => {
      order.push("poll");
      return new Response(JSON.stringify({ accessToken: jwt({}), refreshToken: "r" }), { status: 200 });
    }) as unknown as typeof fetch;

    await loginCursor({
      onAuth: async () => {
        order.push("auth");
      },
    });
    expect(order).toEqual(["auth", "poll"]);
  });
});
