import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCursorUsage, formatUsd, parsePeriodUsage, type CursorUsageSummary } from "../auth/usage.js";
import { USAGE_URL } from "../config.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Raw response captured from a live account (2026-09-04). */
const PERIOD_USAGE = {
  billingCycleStart: "1787813004000",
  billingCycleEnd: "1790491404000",
  planUsage: {
    totalSpend: 15685,
    includedSpend: 2000,
    bonusSpend: 13685,
    limit: 2000,
    remainingBonus: false,
    bonusTooltip: "We work with model providers to give you free usage.",
    autoPercentUsed: 33.742222222222225,
    apiPercentUsed: 22.26666666666667,
    totalPercentUsed: 33.195767195767196,
  },
  spendLimitUsage: { limitType: "user" },
  displayThreshold: 200,
  enabled: true,
  displayMessage: "You've hit your usage limit",
  autoModelSelectedDisplayMessage: "You've used 33% of your included total usage",
  namedModelSelectedDisplayMessage: "You've used 22% of your included API usage",
  autoBucketModels: ["default", "composer-2.5"],
};

describe("parsePeriodUsage", () => {
  it("exposes the dashboard gauge percentages", () => {
    const summary = parsePeriodUsage(PERIOD_USAGE);
    expect(summary.percents).toEqual({
      total: 33.195767195767196,
      auto: 33.742222222222225,
      api: 22.26666666666667,
    });
  });

  it("maps spend figures to cents", () => {
    const summary = parsePeriodUsage(PERIOD_USAGE);
    expect(summary.totalSpendCents).toBe(15685); // $156.85
    expect(summary.spendCapCents).toBe(2000); // $20.00 monthly cap
    expect(summary.bonusSpendCents).toBe(13685); // $136.85 promotional
  });

  it("flags a hit usage limit with the server's own message", () => {
    const summary = parsePeriodUsage(PERIOD_USAGE);
    expect(summary.limitHit).toBe(true);
    expect(summary.statusMessage).toBe("You've hit your usage limit");
  });

  it("does not flag the limit when enabled is false", () => {
    const summary = parsePeriodUsage({ ...PERIOD_USAGE, enabled: false });
    expect(summary.limitHit).toBe(false);
  });

  it("reports team membership from the spend limit type", () => {
    const summary = parsePeriodUsage({ ...PERIOD_USAGE, spendLimitUsage: { limitType: "team" } });
    expect(summary.membershipType).toBe("Team");
  });

  it("prefers an explicit membershipType when limitType is absent", () => {
    const summary = parsePeriodUsage({ ...PERIOD_USAGE, spendLimitUsage: {}, membershipType: "Business" });
    expect(summary.membershipType).toBe("Business");
  });

  it("parses billing cycle timestamps", () => {
    const summary = parsePeriodUsage(PERIOD_USAGE);
    expect(summary.billingCycleEnd).toBe(new Date(1790491404000).toISOString());
    expect(summary.billingCycleStart).toBe(new Date(1787813004000).toISOString());
  });

  it("tolerates a missing planUsage", () => {
    const summary = parsePeriodUsage({ membershipType: "Pro" });
    expect(summary.percents).toEqual({ total: null, auto: null, api: null });
    expect(summary.spendCapCents).toBeNull();
    expect(summary.limitHit).toBe(false);
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
    expect(summary.percents.total).toBeCloseTo(33.2, 1);

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

/** Shared fixture for formatter tests. */
export function usageFixture(overrides: Partial<CursorUsageSummary> = {}): CursorUsageSummary {
  return {
    billingCycleStart: "2026-08-27T06:43:24.000Z",
    billingCycleEnd: "2026-09-27T06:43:24.000Z",
    membershipType: "Pro",
    limitType: "user",
    percents: { total: 33.2, auto: 33.7, api: 22.3 },
    statusMessage: "You've hit your usage limit",
    spendCapCents: 2000,
    totalSpendCents: 15685,
    bonusSpendCents: 13685,
    limitHit: true,
    ...overrides,
  };
}
