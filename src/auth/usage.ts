/**
 * Current-period usage via `DashboardService/GetCurrentPeriodUsage`.
 *
 * A Connect *JSON* unary call: plain HTTPS POST with `{}` and the OAuth bearer
 * token. Percentages are 0–100. `spendLimitUsage.limitType` distinguishes
 * individual ("user" → Pro) from team ("team" → Team) billing.
 *
 * NOTE on units: `planUsage.includedSpend`/`limit` are not currency. Empirically
 * they are plan units whose ratio differs from `totalPercentUsed` (a real
 * account showed spend=limit=2000 at 32.6% used), so they are rendered as raw
 * units, never as dollars. Only `spendLimitUsage.includedSpend` — actual
 * on-demand spend — is treated as cents.
 */
import { USAGE_URL } from "../config.js";

export interface UsageBucket {
  enabled?: boolean;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  totalPercentUsed: number | null;
  autoPercentUsed: number | null;
  apiPercentUsed: number | null;
}

export interface CursorUsageSummary {
  billingCycleStart?: string;
  billingCycleEnd?: string;
  membershipType: string;
  limitType?: string;
  plan?: UsageBucket;
  onDemandSpendCents?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

  // Raw plan units (see NOTE above) — displayed verbatim, not as currency.
  const used = numberOrNull(planUsage?.includedSpend);
  const limit = numberOrNull(planUsage?.limit);

  return {
    billingCycleStart: msToIso(value.billingCycleStart),
    billingCycleEnd: msToIso(value.billingCycleEnd),
    membershipType,
    limitType,
    plan: planUsage
      ? {
          enabled: true,
          used,
          limit,
          remaining: used !== null && limit !== null ? Math.max(0, limit - used) : null,
          totalPercentUsed: numberOrNull(planUsage.totalPercentUsed),
          autoPercentUsed: numberOrNull(planUsage.autoPercentUsed),
          apiPercentUsed: numberOrNull(planUsage.apiPercentUsed),
        }
      : undefined,
    onDemandSpendCents: numberOrNull(spendLimitUsage?.includedSpend),
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

/** Format raw plan units with thousands separators; null/undefined → em dash. */
export function formatUnits(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US", { maximumFractionDigits: 0 });
}
