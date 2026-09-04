import { describe, expect, it, vi } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  GetBlobArgsSchema,
  HeartbeatUpdateSchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  McpArgsSchema,
  ReadArgsSchema,
  RequestContextArgsSchema,
  SetBlobArgsSchema,
  TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema,
  TokenDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  ConversationStateStructureSchema,
  ConversationTokenDetailsSchema,
  ExecServerControlMessageSchema,
  ExecServerAbortSchema,
  type McpToolDefinition,
} from "../proto/agent_pb.js";
import { BlobStore } from "../protocol/blobs.js";
import { encodeArgs } from "../protocol/request.js";
import { handleServerMessage, type PendingToolCall, type ServerHandlers } from "../protocol/server.js";

function makeHandlers(overrides: Partial<ServerHandlers> = {}) {
  const sent: Uint8Array[] = [];
  const calls: PendingToolCall[] = [];
  const texts: string[] = [];
  const thinking: string[] = [];
  const errors: string[] = [];
  const ended: number[] = [];
  const usage: number[] = [];
  let tokens = 0;
  let liveness = 0;

  const handlers: ServerHandlers = {
    blobs: new BlobStore(),
    toolDefinitions: [
      { name: "mcp_pi_bash", providerIdentifier: "pi", toolName: "bash", description: "", inputSchema: new Uint8Array() },
    ] as McpToolDefinition[],
    onText: (t) => texts.push(t),
    onThinking: (t) => thinking.push(t),
    onTokenDelta: (n) => {
      tokens += n;
    },
    onTurnEnded: () => ended.push(Date.now()),
    onUsage: (n) => usage.push(n),
    onToolCall: (c) => calls.push(c),
    onError: (m) => errors.push(m),
    onLiveness: () => {
      liveness += 1;
    },
    send: (msg) => sent.push(toBinary(AgentClientMessageSchema, msg as never)),
    ...overrides,
  };

  return { handlers, sent, calls, texts, thinking, errors, ended, usage, tokens: () => tokens, liveness: () => liveness };
}

function frame(message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): Uint8Array {
  return toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message));
}

// ── oneof narrowing helpers ────────────────────────────────────────────────

function kvReplyOf(bytes: Uint8Array) {
  const message = fromBinary(AgentClientMessageSchema, bytes).message;
  if (message.case !== "kvClientMessage") throw new Error(`expected kvClientMessage, got ${message.case}`);
  const kv = message.value.message;
  if (kv.case !== "getBlobResult" && kv.case !== "setBlobResult") throw new Error(`unexpected kv case ${kv.case}`);
  return kv;
}

function execReplyOf(bytes: Uint8Array) {
  const message = fromBinary(AgentClientMessageSchema, bytes).message;
  if (message.case !== "execClientMessage") throw new Error(`expected execClientMessage, got ${message.case}`);
  return message.value.message;
}

function update(value: unknown): Uint8Array {
  return frame({
    message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, value as never) },
  });
}

describe("handleServerMessage", () => {
  it("routes text deltas", () => {
    const h = makeHandlers();
    handleServerMessage(
      update({ message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "hello" }) } }),
      h.handlers,
    );
    expect(h.texts).toEqual(["hello"]);
  });

  it("routes thinking deltas", () => {
    const h = makeHandlers();
    handleServerMessage(
      update({ message: { case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text: "hmm" }) } }),
      h.handlers,
    );
    expect(h.thinking).toEqual(["hmm"]);
  });

  it("accumulates token deltas", () => {
    const h = makeHandlers();
    handleServerMessage(update({ message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 5 }) } }), h.handlers);
    handleServerMessage(update({ message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: 3 }) } }), h.handlers);
    expect(h.tokens()).toBe(8);
  });

  it("fires turnEnded", () => {
    const h = makeHandlers();
    handleServerMessage(update({ message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) } }), h.handlers);
    expect(h.ended).toHaveLength(1);
  });

  it("treats heartbeats as liveness only", () => {
    const h = makeHandlers();
    handleServerMessage(update({ message: { case: "heartbeat", value: create(HeartbeatUpdateSchema, {}) } }), h.handlers);
    expect(h.liveness()).toBe(1);
    expect(h.texts).toEqual([]);
  });

  it("answers a KV get_blob_args from the store", () => {
    const h = makeHandlers();
    const data = new TextEncoder().encode("blob-content");
    const id = h.handlers.blobs.put(data);
    handleServerMessage(
      frame({
        message: {
          case: "kvServerMessage",
          value: create(KvServerMessageSchema, {
            id: 7,
            message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: id }) },
          }),
        },
      }),
      h.handlers,
    );
    expect(h.sent).toHaveLength(1);
    const kv = kvReplyOf(h.sent[0]);
    expect(kv.case).toBe("getBlobResult");
    if (kv.case !== "getBlobResult") throw new Error("expected getBlobResult");
    expect(new TextDecoder().decode(kv.value.blobData!)).toBe("blob-content");
  });

  it("answers a KV get for a missing blob with an empty result", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "kvServerMessage",
          value: create(KvServerMessageSchema, {
            id: 1,
            message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: new Uint8Array(32) }) },
          }),
        },
      }),
      h.handlers,
    );
    const kv = kvReplyOf(h.sent[0]);
    expect(kv.case).toBe("getBlobResult");
    if (kv.case !== "getBlobResult") throw new Error("expected getBlobResult");
    expect(kv.value.blobData).toBeUndefined();
  });

  it("stores a server-pushed blob and acks", () => {
    const h = makeHandlers();
    const id = new Uint8Array(32).fill(3);
    handleServerMessage(
      frame({
        message: {
          case: "kvServerMessage",
          value: create(KvServerMessageSchema, {
            id: 2,
            message: { case: "setBlobArgs", value: create(SetBlobArgsSchema, { blobId: id, blobData: new Uint8Array([9, 9]) }) },
          }),
        },
      }),
      h.handlers,
    );
    expect(h.handlers.blobs.getByIdBytes(id)).toEqual(new Uint8Array([9, 9]));
    expect(kvReplyOf(h.sent[0]).case).toBe("setBlobResult");
  });

  it("surfaces an MCP exec as a tool call with decoded args", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 11,
            execId: "exec-1",
            message: {
              case: "mcpArgs",
              value: create(McpArgsSchema, {
                name: "mcp_pi_bash",
                toolName: "bash",
                toolCallId: "call-1",
                providerIdentifier: "pi",
                args: encodeArgs({ command: "ls" }),
              }),
            },
          }),
        },
      }),
      h.handlers,
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ execMsgId: 11, execId: "exec-1", toolCallId: "call-1", toolName: "bash" });
    expect(h.calls[0].arguments).toEqual({ command: "ls" });
  });

  it("rejects an unknown MCP tool with tool_not_found", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 5,
            execId: "e",
            message: {
              case: "mcpArgs",
              value: create(McpArgsSchema, { name: "mcp_pi_nope", toolName: "nope", toolCallId: "c", args: {} }),
            },
          }),
        },
      }),
      h.handlers,
    );
    expect(h.calls).toHaveLength(0);
    const exec = execReplyOf(h.sent[0]);
    expect(exec.case).toBe("mcpResult");
    if (exec.case !== "mcpResult") throw new Error("expected mcpResult");
    expect(exec.value.result.case).toBe("toolNotFound");
  });

  it("answers requestContextArgs with the tool list", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 3,
            execId: "rc",
            message: { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) },
          }),
        },
      }),
      h.handlers,
    );
    const exec = execReplyOf(h.sent[0]);
    expect(exec.case).toBe("requestContextResult");
    if (exec.case !== "requestContextResult") throw new Error("expected requestContextResult");
    const result = exec.value.result;
    expect(result.case).toBe("success");
    if (result.case !== "success") throw new Error("expected success");
    expect(result.value.requestContext?.tools).toHaveLength(1);
  });

  it("rejects a native read exec and points at the Pi tool", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 9,
            execId: "read-1",
            message: { case: "readArgs", value: create(ReadArgsSchema, { path: "/tmp/x", toolCallId: "t" }) },
          }),
        },
      }),
      h.handlers,
    );
    const exec = execReplyOf(h.sent[0]);
    expect(exec.case).toBe("readResult");
    if (exec.case !== "readResult") throw new Error("expected readResult");
    const result = exec.value.result;
    expect(result.case).toBe("rejected");
    if (result.case !== "rejected") throw new Error("expected rejected");
    expect(result.value.reason).toMatch(/MCP tool/);
  });

  it("throws on an unknown exec case", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "execServerMessage",
          value: create(ExecServerMessageSchema, {
            id: 1,
            execId: "x",
            message: { case: "recordScreenArgs", value: create(RequestContextArgsSchema, {}) as never },
          }),
        },
      }),
      h.handlers,
    );
    // recordScreenArgs is handled → failure result, not thrown.
    expect(execReplyOf(h.sent[0]).case).toBe("recordScreenResult");
  });

  it("reports checkpoint token usage", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "conversationCheckpointUpdate",
          value: create(ConversationStateStructureSchema, {
            tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 1234, maxTokens: 200000 }),
          }),
        },
      }),
      h.handlers,
    );
    expect(h.usage).toEqual([1234]);
  });

  it("treats a 0-token checkpoint as liveness", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "conversationCheckpointUpdate",
          value: create(ConversationStateStructureSchema, {
            tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens: 0, maxTokens: 200000 }),
          }),
        },
      }),
      h.handlers,
    );
    expect(h.usage).toEqual([]);
    expect(h.liveness()).toBe(1);
  });

  it("surfaces a server abort as an error", () => {
    const h = makeHandlers();
    handleServerMessage(
      frame({
        message: {
          case: "execServerControlMessage",
          value: create(ExecServerControlMessageSchema, {
            message: { case: "abort", value: create(ExecServerAbortSchema, { id: 1 }) },
          }),
        },
      }),
      h.handlers,
    );
    expect(h.errors.join()).toMatch(/abort/i);
  });

  it("ignores undecodable frames without throwing", () => {
    const h = makeHandlers();
    expect(() => handleServerMessage(new Uint8Array([0xff, 0xff, 0xff]), h.handlers)).not.toThrow();
  });

  it("dispatches send through the injected writer", () => {
    const send = vi.fn();
    const h = makeHandlers({ send });
    handleServerMessage(
      frame({
        message: {
          case: "kvServerMessage",
          value: create(KvServerMessageSchema, {
            id: 1,
            message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: new Uint8Array(32) }) },
          }),
        },
      }),
      h.handlers,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
