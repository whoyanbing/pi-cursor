/**
 * Pi auto-compacts when `lastAssistant.usage.totalTokens` exceeds
 * `contextWindow - reserveTokens` (~94% of a 256k window).
 *
 * Cursor reports prompt size into that usage field. After a compact, the kept
 * assistant messages still carry the pre-compact total (240k+), and Cursor may
 * keep reporting that size until the conversation id rotates. Pi's between-turn
 * check trusts the number, so the footer stays at 94–95% and compact runs again
 * immediately.
 *
 * Skip a threshold compact on the Cursor provider when we have already compacted
 * and post-compact usage has not yet dropped below the previous `tokensBefore`.
 * Manual `/compact` and overflow recovery still run.
 */
export interface CompactGuardUsage {
  input?: number;
  totalTokens?: number;
}

export interface CompactGuardEntry {
  type: string;
  timestamp?: number | string;
  tokensBefore?: number;
  message?: {
    role?: string;
    timestamp?: number;
    usage?: CompactGuardUsage;
  };
}

export interface CompactGuardEvent {
  reason: "manual" | "threshold" | "overflow";
  preparation: { tokensBefore: number };
  branchEntries: readonly CompactGuardEntry[];
}

/** Usage still at or above this fraction of `tokensBefore` is treated as stale. */
export const STALE_USAGE_RATIO = 0.85;

export const CURSOR_PROVIDER = "cursor";

function entryTime(entry: CompactGuardEntry): number {
  const messageTs = entry.message?.timestamp;
  if (typeof messageTs === "number" && Number.isFinite(messageTs) && messageTs > 0) {
    return messageTs;
  }
  if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
  if (typeof entry.timestamp === "string") {
    const parsed = Date.parse(entry.timestamp);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function usageTokens(usage: CompactGuardUsage | undefined): number {
  if (!usage) return 0;
  const total = usage.totalTokens ?? 0;
  if (total > 0) return total;
  return usage.input ?? 0;
}

function latestCompaction(entries: readonly CompactGuardEntry[]): CompactGuardEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].type === "compaction") return entries[i];
  }
  return undefined;
}

export function shouldSkipStaleThresholdCompact(event: CompactGuardEvent): boolean {
  if (event.reason !== "threshold") return false;
  const previous = latestCompaction(event.branchEntries);
  if (!previous) return false;

  const compactedAt = entryTime(previous);
  const before =
    previous.tokensBefore && previous.tokensBefore > 0 ? previous.tokensBefore : event.preparation.tokensBefore;
  const dropBelow = before > 0 ? Math.floor(before * STALE_USAGE_RATIO) : 0;

  let sawPostCompactUsage = false;
  let sawDrop = false;
  for (const entry of event.branchEntries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entryTime(entry) <= compactedAt) continue;
    const tokens = usageTokens(entry.message?.usage);
    if (tokens <= 0) continue;
    sawPostCompactUsage = true;
    if (dropBelow <= 0 || tokens < dropBelow) sawDrop = true;
  }

  if (!sawPostCompactUsage) return true;
  return !sawDrop;
}

/** Only the Cursor provider has the stale-usage loop; other providers compact normally. */
export function shouldCancelThresholdCompact(
  event: CompactGuardEvent,
  provider: string | undefined,
): boolean {
  if (provider !== CURSOR_PROVIDER) return false;
  return shouldSkipStaleThresholdCompact(event);
}
