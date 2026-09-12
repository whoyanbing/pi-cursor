import { describe, expect, it } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { parseConversation } from "../protocol/context.js";
import { buildHistory, encodeMessage, mcpToolName, piToolName, turnMessages } from "../protocol/prompt.js";

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

function toolResult(toolCallId: string, toolName: string, text: string, isError = false): Context["messages"][number] {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError,
    timestamp: Date.now(),
  } as never;
}

describe("parseConversation", () => {
  it("treats a trailing user message as the action", () => {
    const parsed = parseConversation({ systemPrompt: "sys", messages: [user("hi")] });
    expect(parsed.action).toEqual({ kind: "userMessage", text: "hi", images: [] });
    expect(parsed.completedTurns).toHaveLength(0);
  });

  it("folds prior turns into history", () => {
    const parsed = parseConversation({
      systemPrompt: "sys",
      messages: [user("first"), assistantText("answer"), user("second")],
    });
    expect(parsed.completedTurns).toHaveLength(1);
    expect(parsed.completedTurns[0].userText).toBe("first");
    expect(parsed.completedTurns[0].steps).toEqual([{ kind: "text", text: "answer" }]);
    expect(parsed.action).toMatchObject({ kind: "userMessage", text: "second" });
  });

  it("folds trailing tool results into the in-flight turn", () => {
    const parsed = parseConversation({
      systemPrompt: "sys",
      messages: [
        user("run it"),
        assistantToolCall("call_1", "bash", { command: "ls" }),
        toolResult("call_1", "bash", "file.txt"),
      ],
    });
    expect(parsed.action).toMatchObject({ kind: "continue" });
    expect(parsed.completedTurns).toHaveLength(1);
    const step = parsed.completedTurns[0].steps[0];
    expect(step).toMatchObject({ kind: "toolCall", toolCallId: "call_1", toolName: "bash" });
    expect((step as { result?: { content: string } }).result?.content).toBe("file.txt");
  });

  it("drops unanswered tool calls from history", () => {
    const parsed = parseConversation({
      systemPrompt: "",
      messages: [user("go"), assistantToolCall("a", "read", {}), user("never mind")],
    });
    expect(parsed.completedTurns[0].steps).toHaveLength(0);
  });

  it("treats a compaction summary as a user-like turn", () => {
    const parsed = parseConversation({
      systemPrompt: "sys",
      messages: [
        {
          role: "compactionSummary",
          summary: "## Goal\nShip the feature",
          timestamp: Date.now(),
        } as never,
        user("continue"),
      ],
    });
    expect(parsed.completedTurns).toHaveLength(1);
    expect(parsed.completedTurns[0].userText).toContain("Ship the feature");
    expect(parsed.action).toMatchObject({ kind: "userMessage", text: "continue" });
  });

  it("keeps error flags on tool results", () => {
    const parsed = parseConversation({
      systemPrompt: "",
      messages: [user("go"), assistantToolCall("a", "bash", {}), toolResult("a", "bash", "boom", true)],
    });
    const step = parsed.completedTurns[0].steps[0] as { result?: { isError: boolean } };
    expect(step.result?.isError).toBe(true);
  });

  it("truncates long bashExecution output to the tail", () => {
    const parsed = parseConversation({
      systemPrompt: "",
      messages: [
        {
          role: "bashExecution",
          command: "cat big.log",
          output: `x`.repeat(20_000),
          timestamp: Date.now(),
        } as never,
        user("next"),
      ],
    });
    const text = parsed.completedTurns[0].userText;
    expect(text).toContain("cat big.log");
    expect(text.length).toBeLessThan(20_000);
    expect(text).toMatch(/truncated/i);
  });

  it("parses images from user content blocks", () => {
    const parsed = parseConversation({
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: Buffer.from("img").toString("base64"), mimeType: "image/png" },
          ],
          timestamp: Date.now(),
        } as never,
      ],
    });
    expect(parsed.action.kind).toBe("userMessage");
    if (parsed.action.kind === "userMessage") {
      expect(parsed.action.images).toHaveLength(1);
      expect(parsed.action.images[0].mimeType).toBe("image/png");
      expect(new TextDecoder().decode(parsed.action.images[0].data)).toBe("img");
    }
  });
});

describe("prompt history", () => {
  it("namespaces mcp tool names both ways", () => {
    expect(mcpToolName("bash")).toBe("mcp_pi_bash");
    expect(mcpToolName("mcp_pi_bash")).toBe("mcp_pi_bash");
    expect(piToolName("mcp_pi_bash")).toBe("bash");
    expect(piToolName("other")).toBe("other");
  });

  it("frames the system prompt as a rules user message", () => {
    const history = buildHistory("be helpful", []);
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe("user");
    const content = (history[0] as { content: Array<{ text: string }> }).content;
    expect(content[0].text).toContain("<rules>");
    expect(content[0].text).toContain("be helpful");
  });

  it("renders completed turns as user/assistant/tool messages", () => {
    const parsed = parseConversation({
      systemPrompt: "sys",
      messages: [
        user("do it"),
        assistantText("sure"),
        assistantToolCall("c1", "bash", { command: "ls" }),
        toolResult("c1", "bash", "ok"),
        assistantText("done"),
        user("next"),
      ],
    });
    const messages = turnMessages(parsed.completedTurns[0]);
    expect(messages[0]).toMatchObject({ role: "user" });
    expect((messages[0] as { content: Array<{ text: string }> }).content[0].text).toContain("<user_query>");
    expect((messages[0] as { content: Array<{ text: string }> }).content[0].text).toContain("do it");

    const assistant = messages[1] as unknown as { role: string; content: Array<Record<string, unknown>> };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content[0]).toMatchObject({ type: "text", text: "sure" });
    expect(assistant.content[1]).toMatchObject({ type: "tool-call", toolCallId: "c1", toolName: "mcp_pi_bash" });

    const tool = messages[2] as unknown as { role: string; content: Array<Record<string, unknown>> };
    expect(tool.role).toBe("tool");
    expect(tool.content[0]).toMatchObject({ type: "tool-result", toolCallId: "c1", result: "ok" });

    expect(messages[3]).toMatchObject({ role: "assistant" });
  });

  it("truncates huge replayed tool results", () => {
    const parsed = parseConversation({
      systemPrompt: "",
      messages: [user("go"), assistantToolCall("c", "bash", {}), toolResult("c", "bash", "x".repeat(50_000)), user("next")],
    });
    const messages = turnMessages(parsed.completedTurns[0]);
    const tool = messages.find((m) => m.role === "tool") as { content: Array<{ result: string }> };
    expect(tool.content[0].result.length).toBeLessThan(25_000);
    expect(tool.content[0].result).toContain("truncated");
  });

  it("encodes messages as JSON bytes", () => {
    const bytes = encodeMessage({ role: "user", content: [{ type: "text", text: "hi" }] });
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ role: "user", content: [{ type: "text", text: "hi" }] });
  });
});
