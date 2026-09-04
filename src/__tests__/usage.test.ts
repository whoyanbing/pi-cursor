import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCursorUsage, formatUsd, parsePeriodUsage } from "../auth/usage.js";
import { USAGE_URL } from "../config.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const PERIOD_USAGE = {
  billingCycleStart: "1756684800000",
  billingCycleEnd: "1759276800000",
  planUsage: {
    totalPercentUsed: 42,
    autoPercentUsed: 30,
    apiPercentUsed: 12,
    includedSpend: 8400,
    limit: 20000,
  },
  spendLimitUsage: { limitType: "user" },
};

describe("parsePeriodUsage", () => {
  it("maps plan usage into cents-based buckets", () => {
    const summary = parsePeriodUsage(PERIOD_USAGE);
    expect(summary.membershipType).toBe("Pro");
    expect(summary.limitType).toBe("user");
    expect(summary.plan).toMatchObject({
      enabled: true,
      used: 8400,
      limit: 20000,
      remaining: 11600,
      totalPercentUsed: 42,
      autoPercentUsed: 30,
      apiPercentUsed: 12,
    });
    expect(summary.billingCycleEnd).toBe(new Date(1759276800000).toISOString());
    expect(summary.billingCycleStart).toBe(new Date(1756684800000).toISOString());
  });

  it("reports team membership from the spend limit type", () => {
    const summary = parsePeriodUsage({
      ...PERIOD_USAGE,
      spendLimitUsage: { limitType: "team" },
    });
    expect(summary.membershipType).toBe("Team");
  });

  it("prefers an explicit membershipType when limitType is absent", () => {
    const summary = parsePeriodUsage({ ...PERIOD_USAGE, spendLimitUsage: {}, membershipType: "Business" });
    expect(summary.membershipType).toBe("Business");
  });

  it("clamps remaining at zero for overage", () => {
    const summary = parsePeriodUsage({
      planUsage: { includedSpend: 25000, limit: 20000, totalPercentUsed: 125 },
    });
    expect(summary.plan?.remaining).toBe(0);
  });

  it("tolerates missing planUsage", () => {
    const summary = parsePeriodUsage({ membershipType: "Pro" });
    expect(summary.plan).toBeUndefined();
    expect(summary.membershipType).toBe("Pro");
  });

  it("rejects non-object responses", () => {
    expect(() => parsePeriodUsage("nope")).toThrow(/invalid response/);
    expect(() => parsePeriodUsage(null)).toThrow(/invalid response/);
  });
});

describe("fetchCursorUsage", () => {
  it("POSTs an empty JSON body with the bearer token", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify(PERIOD_USAGE), { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;

    const summary = await fetchCursorUsage("token-1");
    expect(summary.plan?.used).toBe(8400);

    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(url).toBe(USAGE_URL);
    expect(init).toMatchObject({
      method: "POST",
      body: "{}",
      headers: { Authorization: "Bearer token-1", "Content-Type": "application/json" },
    });
  });

  it("surfaces HTTP failures", async () => {
    globalThis.fetch = vi.fn(async () => new Response("quota", { status: 403 })) as unknown as typeof fetch;
    await expect(fetchCursorUsage("t")).rejects.toThrow(/HTTP 403/);
  });
});

describe("formatUsd", () => {
  it("formats cents as dollars", () => {
    expect(formatUsd(8400)).toBe("$84.00");
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12345)).toBe("$123.45");
  });

  it("renders missing values as a dash", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });
});
