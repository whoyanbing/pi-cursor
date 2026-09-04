import { describe, expect, it } from "vitest";
import {
  shouldCancelThresholdCompact,
  shouldSkipStaleThresholdCompact,
  type CompactGuardEvent,
} from "../compaction-guard.js";

function event(overrides: Partial<CompactGuardEvent> & { branchEntries: CompactGuardEvent["branchEntries"] }): CompactGuardEvent {
  return {
    reason: "threshold",
    preparation: { tokensBefore: 240_705 },
    ...overrides,
  };
}

function compaction(timestamp: string, tokensBefore = 240_070) {
  return { type: "compaction", timestamp, tokensBefore };
}

function assistant(timestamp: string, totalTokens: number) {
  return {
    type: "message",
    timestamp,
    message: {
      role: "assistant",
      timestamp: Date.parse(timestamp),
      usage: { input: totalTokens, totalTokens },
    },
  };
}

describe("shouldSkipStaleThresholdCompact", () => {
  it("allows the first threshold compact", () => {
    expect(
      shouldSkipStaleThresholdCompact(
        event({
          branchEntries: [assistant("2026-09-04T16:29:00.000Z", 240_070)],
        }),
      ),
    ).toBe(false);
  });

  it("skips when the only usage is from before the last compact", () => {
    expect(
      shouldSkipStaleThresholdCompact(
        event({
          branchEntries: [
            assistant("2026-09-04T16:29:00.000Z", 240_070),
            compaction("2026-09-04T16:30:16.818Z"),
            { type: "message", timestamp: "2026-09-04T16:30:16.826Z", message: { role: "assistant", usage: { input: 0, totalTokens: 0 } } },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("skips when post-compact usage is still the pre-compact prompt size", () => {
    expect(
      shouldSkipStaleThresholdCompact(
        event({
          preparation: { tokensBefore: 240_705 },
          branchEntries: [
            compaction("2026-09-04T16:30:16.818Z", 240_070),
            assistant("2026-09-04T16:30:51.000Z", 242_373),
          ],
        }),
      ),
    ).toBe(true);
  });

  it("allows compact after a real post-compact usage drop", () => {
    expect(
      shouldSkipStaleThresholdCompact(
        event({
          preparation: { tokensBefore: 239_800 },
          branchEntries: [
            compaction("2026-09-04T16:30:16.818Z"),
            assistant("2026-09-04T16:32:19.104Z", 25_499),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("allows a later compact once usage has dropped and then grown again", () => {
    expect(
      shouldSkipStaleThresholdCompact(
        event({
          preparation: { tokensBefore: 241_000 },
          branchEntries: [
            compaction("2026-09-04T16:30:16.818Z", 240_070),
            assistant("2026-09-04T16:32:19.104Z", 25_499),
            assistant("2026-09-04T18:00:00.000Z", 241_000),
          ],
        }),
      ),
    ).toBe(false);
  });

  it("does not skip manual or overflow compaction", () => {
    const branchEntries = [assistant("2026-09-04T16:29:00.000Z", 240_070), compaction("2026-09-04T16:30:16.818Z")];
    expect(shouldSkipStaleThresholdCompact(event({ reason: "manual", branchEntries }))).toBe(false);
    expect(shouldSkipStaleThresholdCompact(event({ reason: "overflow", branchEntries }))).toBe(false);
  });
});

describe("shouldCancelThresholdCompact", () => {
  const stale = event({
    branchEntries: [compaction("2026-09-04T16:30:16.818Z", 240_070), assistant("2026-09-04T16:30:51.000Z", 242_373)],
  });

  it("cancels only for the cursor provider", () => {
    expect(shouldCancelThresholdCompact(stale, "cursor")).toBe(true);
    expect(shouldCancelThresholdCompact(stale, "weixin")).toBe(false);
    expect(shouldCancelThresholdCompact(stale, "qoder")).toBe(false);
    expect(shouldCancelThresholdCompact(stale, undefined)).toBe(false);
  });
});
