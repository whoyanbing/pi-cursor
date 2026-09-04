/**
 * Current-period usage via `DashboardService/GetCurrentPeriodUsage`.
 *
 * A Connect *JSON* unary call: plain HTTPS POST with `{}` and the OAuth bearer
 * token. `spendLimitUsage.limitType` distinguishes individual ("user" → Pro)
 * from team ("team" → Team) billing.
 *
 * Units, verified against a live account:
 *   - `planUsage.total/auto/apiPercentUsed` are the dashboard gauges (0–100).
 *     The server's own `displayMessage` sentences match them exactly, so these
 *     are what we render.
 *   - `planUsage.totalSpend / includedSpend / bonusSpend / limit` are spend
 *     figures in **cents** ($156.85 / $20.00 / $136.85 / $20.00), but their
 *     ratio does NOT equal the percent gauge (spend counts bonus usage and the
 *     gauge tracks included allowance differently). They are therefore NOT
 *     rendered as the plan progress bar. `limit` is the configured monthly
 *     spend cap; `totalSpend > limit` is how "You've hit your usage limit"
 *     arises.
 *   - `displayMessage` / `autoModelSelectedDisplayMessage` /
 *     `namedModelSelectedDisplayMessage` are authoritative server-written
 *     status sentences, surfaced verbatim.
 */
import { USAGE_URL } from "../config.js";

export interface UsagePercentages {
  total: number | null;
  auto: number | null;
  api: number | null;
}

export interface CursorUsageSummary {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType: string;
  limitType?: string;
  /** Dashboard gauge percentages (0–100). */
  percents: UsagePercentages;
  /** Server-written status sentence (e.g. "You've hit your usage limit"). */
  statusMessage?: string;
  /** Monthly spend cap, in cents (planUsage.limit). */
  spendCapCents: number | null;
  /** Total spend in the period, in cents (included + bonus). */
  totalSpendCents: number | null;
  /** Spend beyond the purchased allowance, in cents (promotional). */
  bonusSpendCents: number | null;
  /** True when the server says the usage limit has been hit. */
  limitHit: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function msToIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string") {
    const ms = Number(value);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return undefined;
}

export function parsePeriodUsage(value: unknown): CursorUsageSummary {
  if (!isRecord(value)) throw new Error("Cursor usage endpoint returned an invalid response");

  const planUsage = isRecord(value.planUsage) ? value.planUsage : undefined;
  const spendLimitUsage = isRecord(value.spendLimitUsage) ? value.spendLimitUsage : undefined;
  const limitType = typeof spendLimitUsage?.limitType === "string" ? spendLimitUsage.limitType : undefined;

  let membershipType = "Pro";
  if (limitType === "user") membershipType = "Pro";
  else if (limitType === "team") membershipType = "Team";
  else if (typeof value.membershipType === "string" && value.membershipType) membershipType = value.membershipType;

  const totalSpendCents = numberOrNull(planUsage?.totalSpend);
  const spendCapCents = numberOrNull(planUsage?.limit);

  return {
    billingCycleStart: msToIso(value.billingCycleStart),
    billingCycleEnd: msToIso(value.billingCycleEnd),
    membershipType,
    limitType,
    percents: {
      total: numberOrNull(planUsage?.totalPercentUsed),
      auto: numberOrNull(planUsage?.autoPercentUsed),
      api: numberOrNull(planUsage?.apiPercentUsed),
    },
    statusMessage: stringOrNull(value.displayMessage),
    spendCapCents,
    totalSpendCents,
    bonusSpendCents: numberOrNull(planUsage?.bonusSpend),
    limitHit: Boolean(value.enabled === true && value.displayMessage && /limit/i.test(String(value.displayMessage))),
  };
}

export async function fetchCursorUsage(accessToken: string, signal?: AbortSignal): Promise<CursorUsageSummary> {
  const response = await fetch(USAGE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "{}",
    signal: signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new Error(`Cursor usage request failed: HTTP ${response.status} ${detail}`);
  }
  return parsePeriodUsage(await response.json());
}

/** Format cents as USD ("$12.34"); null/undefined → an em dash. */
export function formatUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}
