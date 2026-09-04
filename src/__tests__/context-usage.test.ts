import { afterEach, describe, expect, it } from "vitest";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import {
  cachedInputTokens,
  clearAllUsage,
  contextInputTokens,
  estimatePromptTokens,
  stabilizeInputTokens,
} from "../protocol/usage.js";

const model = {
  id: "gpt-5",
  provider: "cursor",
  api: "cursor-native",
  contextWindow: 256_000,
} as unknown as Model<Api>;

function assistant(input: number, timestamp: number): Context["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "cursor-native",
    provider: "cursor",
    model: "gpt-5",
    usage: {
      input,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: input + 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as never;
}

afterEach(clearAllUsage);

describe("Cursor context usage stabilization", () => {
  it("suppresses an implausible drop but accepts a normal adjustment", () => {
    expect(stabilizeInputTokens("c", 180_000)).toBe(180_000);
    expect(stabilizeInputTokens("c", 17_000)).toBe(180_000);
    expect(stabilizeInputTokens("c", 150_000)).toBe(150_000);
    expect(cachedInputTokens("c")).toBe(150_000);
  });

  it("recovers a stable baseline from persisted history after reload", () => {
    const context = {
      systemPrompt: "sys",
      messages: [assistant(180_000, 1), assistant(17_000, 2)],
    } as Context;
    expect(contextInputTokens(context, model)).toBe(180_000);
  });

  it("ignores kept pre-compaction assistant usage", () => {
    const context = {
      systemPrompt: "sys",
      messages: [
        { role: "compactionSummary", summary: "short", timestamp: 100 } as never,
        assistant(180_000, 90),
        assistant(20_000, 110),
      ],
    } as Context;
    expect(contextInputTokens(context, model)).toBe(20_000);
  });

  it("recognizes a compaction summary after Pi converts it to user role", () => {
    const context = {
      systemPrompt: "sys",
      messages: [
        {
          role: "user",
          content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nshort\n</summary>",
          timestamp: 100,
        },
        assistant(180_000, 90),
      ],
    } as Context;
    expect(contextInputTokens(context, model)).toBe(0);
  });

  it("returns a non-zero bounded fallback estimate", () => {
    const context = {
      systemPrompt: "system instructions",
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [],
    } as Context;
    const estimate = estimatePromptTokens(model, context);
    expect(estimate).toBeGreaterThan(0);
    expect(estimate).toBeLessThan(256_000 - 16_384);
  });
});
