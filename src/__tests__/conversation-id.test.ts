import { describe, expect, it } from "vitest";
import { parseConversation } from "../protocol/context.js";
import { __clearConversationIdCacheForTests, buildConversationId, conversationFingerprint } from "../protocol/conversation-id.js";
import type { Context } from "@earendil-works/pi-ai";

function user(text: string): Context["messages"][number] {
  return { role: "user", content: text, timestamp: Date.now() };
}

function assistantText(text: string): Context["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "cursor-native" as never,
    provider: "cursor" as never,
    model: "gpt-5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  } as never;
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): Context["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "cursor-native" as never,
    provider: "cursor" as never,
    model: "gpt-5",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: Date.now(),
  } as never;
}

function toolResult(toolCallId: string, toolName: string, text: string): Context["messages"][number] {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  } as never;
}

describe("buildConversationId", () => {
  it("stays stable when a turn continues with tool results", () => {
    const first = parseConversation({
      systemPrompt: "sys",
      messages: [user("build it"), assistantToolCall("c1", "bash", { command: "ls" })],
    });
    const continued = parseConversation({
      systemPrompt: "sys",
      messages: [
        user("build it"),
        assistantToolCall("c1", "bash", { command: "ls" }),
        toolResult("c1", "bash", "ok"),
      ],
    });
    expect(conversationFingerprint(first)).toBe(conversationFingerprint(continued));
    expect(buildConversationId(first, "gpt-5", "session-1")).toBe(
      buildConversationId(continued, "gpt-5", "session-1"),
    );
  });

  it("rotates after a compaction summary replaces the first prompt", () => {
    const before = parseConversation({
      systemPrompt: "sys",
      messages: [user("original task"), assistantText("working")],
    });
    const after = parseConversation({
      systemPrompt: "sys",
      messages: [
        {
          role: "compactionSummary",
          summary: "## Goal\nContinue the original task with a much shorter history.",
          timestamp: Date.now(),
        } as never,
        user("kept recent prompt"),
        assistantText("ok"),
      ],
    });
    expect(conversationFingerprint(before)).not.toBe(conversationFingerprint(after));
    expect(buildConversationId(before, "gpt-5", "session-1")).not.toBe(
      buildConversationId(after, "gpt-5", "session-1"),
    );
  });

  it("rotates even when the original first prompt is among the kept messages", () => {
    const before = parseConversation({
      systemPrompt: "sys",
      messages: [user("original task"), assistantText("working"), user("keep going")],
    });
    const after = parseConversation({
      systemPrompt: "sys",
      messages: [
        {
          role: "compactionSummary",
          summary: "## Goal\noriginal task",
          timestamp: Date.now(),
        } as never,
        user("original task"),
        assistantText("working"),
        user("keep going"),
      ],
    });
    expect(conversationFingerprint(after)).not.toBe(conversationFingerprint(before));
  });
});

describe("buildConversationId without sessionId", () => {
  it("reuses the id in-process and rotates prompts independently", async () => {
    __clearConversationIdCacheForTests();
    const { parseConversation } = await import("../protocol/context.js");
    const a = parseConversation({ systemPrompt: "sys", messages: [user("same")] });
    const b = parseConversation({ systemPrompt: "sys", messages: [user("same"), assistantText("x")] });
    const c = parseConversation({ systemPrompt: "sys", messages: [user("other")] });
    // Same fingerprint (first prompt) reuses; different first prompt splits.
    expect(buildConversationId(b, "gpt-5")).toBe(buildConversationId(a, "gpt-5"));
    expect(buildConversationId(c, "gpt-5")).not.toBe(buildConversationId(a, "gpt-5"));
  });
});

