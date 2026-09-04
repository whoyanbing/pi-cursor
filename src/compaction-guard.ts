/**
 * Pi auto-compacts when `lastAssistant.usage.totalTokens` exceeds
 * `contextWindow - reserveTokens` (~94% of a 256k window).
 *
 * Cursor reports prompt size into that usage field. After a compact, the kept
 * assistant messages still carry the pre-compact total (240k+). Pi's
 * between-turn check trusts that stale number, so the footer stays at 94–95%
 * and compact runs again immediately — often several times in a row.
 *
 * Skip a threshold compact when we have already compacted and there is not yet
 * a post-compact assistant usage reading to prove the window is still full.
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
  for (const entry of event.branchEntries) {
    if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entryTime(entry) <= compactedAt) continue;
    if (usageTokens(entry.message?.usage) > 0) return false;
  }
  return true;
}
