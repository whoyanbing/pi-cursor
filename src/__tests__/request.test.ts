import { describe, expect, it } from "vitest";
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ConversationStateStructureSchema,
  ConversationTurnStructureSchema,
  UserMessageSchema,
} from "../proto/agent_pb.js";
import { parseConversation } from "../protocol/context.js";
import { buildRunRequest, buildSelectedContextBlob, decodeArgs, encodeArgs } from "../protocol/request.js";
import { buildToolDefinitions } from "../protocol/tools.js";
import type { Context, Tool } from "@earendil-works/pi-ai";

function contextOf(messages: Context["messages"], systemPrompt = "sys"): Context {
  return { systemPrompt, messages } as Context;
}

function user(text: string): Context["messages"][number] {
  return { role: "user", content: text, timestamp: Date.now() } as never;
}

const routing = { modelId: "gpt-5-high", maxMode: false, parameters: [{ id: "reasoning", value: "high" }] };

describe("buildRunRequest", () => {
  it("builds a decodable run request with prompt history blobs", () => {
    const parsed = parseConversation(contextOf([user("hello")]));
    const built = buildRunRequest({
      systemPrompt: parsed.systemPrompt,
      completedTurns: parsed.completedTurns,
      actionText: parsed.action.kind === "userMessage" ? parsed.action.text : "Continue.",
      toolDefinitions: [],
      routing,
      conversationId: "conv-1",
    });

    const client = fromBinary(AgentClientMessageSchema, built.bytes);
    expect(client.message.case).toBe("runRequest");
    if (client.message.case !== "runRequest") throw new Error("expected runRequest");
    const run = client.message.value;
    expect(run.conversationId).toBe("conv-1");
    expect(run.requestedModel?.modelId).toBe("gpt-5-high");
    expect(run.requestedModel?.parameters).toHaveLength(1);
    expect(run.requestedModel?.parameters[0].id).toBe("reasoning");
    expect(run.requestedModel?.parameters[0].value).toBe("high");
    expect(run.action?.action.case).toBe("userMessageAction");
    if (run.action?.action.case !== "userMessageAction") throw new Error("expected userMessageAction");
    expect(run.action.action.value.userMessage?.text).toBe("hello");

    const state = run.conversationState;
    expect(state).toBeDefined();
    expect(state!.clientName).toBe("pi");
    expect(state!.mode).toBe(1);
    // System blob + one rendered history message (the <rules> prompt).
    expect(state!.rootPromptMessagesJson.length).toBe(2);

    // Every referenced blob must resolve in the store.
    for (const blobId of state!.rootPromptMessagesJson) {
      expect(built.blobs.has(blobId)).toBe(true);
    }

    // The first blob is the JSON system message; the second the <rules> frame.
    const systemBlob = built.blobs.getByIdBytes(state!.rootPromptMessagesJson[0])!;
    expect(JSON.parse(new TextDecoder().decode(systemBlob))).toEqual({ role: "system", content: "sys" });
    const rulesBlob = built.blobs.getByIdBytes(state!.rootPromptMessagesJson[1])!;
    const rulesMessage = JSON.parse(new TextDecoder().decode(rulesBlob)) as { content: Array<{ text: string }> };
    expect(rulesMessage.content[0].text).toContain("<rules>");
  });

  it("renders completed turns into history blobs and turn structures", () => {
    const parsed = parseConversation(
      contextOf([
        user("first"),
        {
          role: "assistant",
          content: [{ type: "text", text: "answer" }],
        } as never,
        user("second"),
      ]),
    );
    const built = buildRunRequest({
      systemPrompt: parsed.systemPrompt,
      completedTurns: parsed.completedTurns,
      actionText: "second",
      toolDefinitions: [],
      routing: { modelId: "auto" },
      conversationId: "conv-2",
    });

    const client = fromBinary(AgentClientMessageSchema, built.bytes);
    if (client.message.case !== "runRequest") throw new Error("expected runRequest");
    const state = client.message.value.conversationState!;
    expect(state.turns).toHaveLength(1);

    // Turn structure decodes back to a user message blob + step blobs.
    const turnBytes = built.blobs.getByIdBytes(state.turns[0])!;
    const turn = fromBinary(ConversationTurnStructureSchema, turnBytes);
    expect(turn.turn.case).toBe("agentConversationTurn");
    if (turn.turn.case !== "agentConversationTurn") throw new Error("expected agentConversationTurn");
    const agentTurn = turn.turn.value;
    const userBytes = built.blobs.getByIdBytes(agentTurn.userMessage)!;
    const userMessage = fromBinary(UserMessageSchema, userBytes);
    expect(userMessage.text).toBe("first");
    expect(userMessage.mode).toBe(1);
    expect(userMessage.selectedContextBlob.length).toBeGreaterThan(0);

    // system + <rules> + user_query + assistant = 4 history blobs.
    expect(state.rootPromptMessagesJson.length).toBe(4);
  });

  it("uses the continuation text for in-flight turns", () => {
    const built = buildRunRequest({
      systemPrompt: "sys",
      completedTurns: [],
      actionText: "Continue.",
      toolDefinitions: [],
      routing: { modelId: "auto" },
      conversationId: "conv-3",
    });
    const client = fromBinary(AgentClientMessageSchema, built.bytes);
    if (client.message.case !== "runRequest") throw new Error("expected runRequest");
    const action = client.message.value.action?.action;
    if (action?.case !== "userMessageAction") throw new Error("expected userMessageAction");
    expect(action.value.userMessage?.text).toBe("Continue.");
  });

  it("reuses a provided blob store", () => {
    const parsed = parseConversation(contextOf([user("hi")]));
    const first = buildRunRequest({
      systemPrompt: "sys",
      completedTurns: [],
      actionText: "hi",
      toolDefinitions: [],
      routing: { modelId: "auto" },
      conversationId: "c",
    });
    const before = first.blobs.entries;
    buildRunRequest({
      systemPrompt: parsed.systemPrompt,
      completedTurns: [],
      actionText: "hi",
      toolDefinitions: [],
      routing: { modelId: "auto" },
      conversationId: "c",
      blobs: first.blobs,
    });
    // Identical content dedupes onto the same store.
    expect(first.blobs.entries).toBe(before);
  });

  it("carries tool definitions", () => {
    const tools = [
      { name: "bash", description: "run shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
    ] as unknown as Tool[];
    const built = buildRunRequest({
      systemPrompt: "sys",
      completedTurns: [],
      actionText: "hi",
      toolDefinitions: buildToolDefinitions(tools),
      routing: { modelId: "auto" },
      conversationId: "c",
    });
    const client = fromBinary(AgentClientMessageSchema, built.bytes);
    if (client.message.case !== "runRequest") throw new Error("expected runRequest");
    const mcpTools = client.message.value.mcpTools?.mcpTools ?? [];
    expect(mcpTools).toHaveLength(1);
    expect(mcpTools[0].name).toBe("mcp_pi_bash");
    expect(mcpTools[0].providerIdentifier).toBe("pi");
    expect(mcpTools[0].toolName).toBe("bash");
    expect(mcpTools[0].inputSchema.byteLength).toBeGreaterThan(0);
  });
});

describe("selectedContextBlob wire format", () => {
  it("encodes blob refs as field 1 and client name as field 22", () => {
    const blob = buildSelectedContextBlob([new Uint8Array([1, 2, 3])], "pi");
    // field 1, wire type 2 → tag 0x0a, length 3, bytes
    expect(Array.from(blob.subarray(0, 5))).toEqual([0x0a, 3, 1, 2, 3]);
    // field 22, wire type 2 → tag (22<<3)|2 = 178 = varint 0xb2 0x01
    expect(blob[5]).toBe(0xb2);
    expect(blob[6]).toBe(0x01);
    expect(blob[7]).toBe(2);
    expect(new TextDecoder().decode(blob.subarray(8))).toBe("pi");
  });

  it("handles multiple blob refs", () => {
    const blob = buildSelectedContextBlob([new Uint8Array([1]), new Uint8Array([2])], "pi");
    // Each ref is tag(0x0a) + len + data → second ref starts at offset 3.
    expect(blob[0]).toBe(0x0a);
    expect(blob[3]).toBe(0x0a);
    expect(Array.from(blob.subarray(0, 6))).toEqual([0x0a, 1, 1, 0x0a, 1, 2]);
  });
});

describe("mcp arg codec", () => {
  it("round-trips structured values", () => {
    const args = { command: "ls -la", count: 3, nested: { a: [1, 2] }, flag: true };
    const decoded = decodeArgs(encodeArgs(args));
    expect(decoded).toEqual(args);
  });

  it("round-trips an empty object", () => {
    expect(decodeArgs(encodeArgs({}))).toEqual({});
  });
});

describe("conversation state defaults", () => {
  it("sets workspace uri and empty collections", () => {
    const built = buildRunRequest({
      systemPrompt: "sys",
      completedTurns: [],
      actionText: "hi",
      toolDefinitions: [],
      routing: { modelId: "auto" },
      conversationId: "c",
    });
    const client = fromBinary(AgentClientMessageSchema, built.bytes);
    if (client.message.case !== "runRequest") throw new Error("expected runRequest");
    const state = client.message.value.conversationState!;
    expect(state.previousWorkspaceUris[0]).toMatch(/^file:\/\//);
    expect(state.pendingToolCalls).toEqual([]);
    expect(state.todos).toEqual([]);
    expect(state.selfSummaryCount).toBe(0);
    expect(toBinary(ConversationStateStructureSchema, state).byteLength).toBeGreaterThan(0);
  });

  it("uses the provided workspace cwd", () => {
    const built = buildRunRequest({
      systemPrompt: "sys",
      completedTurns: [],
      actionText: "hi",
      toolDefinitions: [],
      routing: { modelId: "auto" },
      conversationId: "c",
      workspaceCwd: "/tmp/pi-cursor-workspace",
    });
    const client = fromBinary(AgentClientMessageSchema, built.bytes);
    if (client.message.case !== "runRequest") throw new Error("expected runRequest");
    expect(client.message.value.conversationState!.previousWorkspaceUris[0]).toBe("file:///tmp/pi-cursor-workspace");
  });
});
