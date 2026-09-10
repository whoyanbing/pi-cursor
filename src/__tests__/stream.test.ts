import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import type { Api, AssistantMessage, AssistantMessageEvent, Context, Model, Tool } from "@earendil-works/pi-ai";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  GetBlobArgsSchema,
  McpArgsSchema,
  ReadArgsSchema,
  ConversationStateStructureSchema,
  ConversationTokenDetailsSchema,
  TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema,
  TokenDeltaUpdateSchema,
  TurnEndedUpdateSchema,
} from "../proto/agent_pb.js";
import { encodeFrame } from "../transport/connect.js";
import type { RpcStream, StreamEndInfo } from "../transport/h2.js";
import { clearAllBridges, peekBridge } from "../protocol/bridge.js";
import { encodeArgs } from "../protocol/request.js";
import { streamCursor } from "../protocol/stream.js";
import { buildConversationId } from "../protocol/conversation-id.js";
import { clearAllUsage } from "../protocol/usage.js";
import { parseConversation } from "../protocol/context.js";

// ── Fake transport ───────────────────────────────────────────────────────────

const transport = vi.hoisted(() => ({
  streams: [] as FakeStream[],
  nextEnd: null as StreamEndInfo | null,
  failOpen: null as Error | null,
}));

class FakeStream implements RpcStream {
  readonly written: Buffer[] = [];
  destroyed = false;
  ended = false;
  private dataCb: ((chunk: Buffer) => void) | null = null;
  private endCb: ((info: StreamEndInfo) => void) | null = null;
  private errorCb: ((error: Error) => void) | null = null;

  constructor(readonly options: { rpcPath: string; token: string }) {}

  get alive(): boolean {
    return !this.destroyed && !this.ended;
  }

  write(frame: Uint8Array): void {
    if (!this.alive) return;
    this.written.push(Buffer.from(frame));
  }

  end(): void {
    this.ended = true;
  }

  destroy(): void {
    this.destroyed = true;
  }

  onData(cb: (chunk: Buffer) => void): void {
    this.dataCb = cb;
  }

  onEnd(cb: (info: StreamEndInfo) => void): void {
    this.endCb = cb;
  }

  onError(cb: (error: Error) => void): void {
    this.errorCb = cb;
  }

  // Test drivers
  emit(frame: Uint8Array): void {
    this.dataCb?.(Buffer.from(frame));
  }

  serverFrame(message: Parameters<typeof create<typeof AgentServerMessageSchema>>[1]): void {
    this.emit(encodeFrame(toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, message))));
  }

  text(delta: string): void {
    this.serverFrame({
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: delta }) } }) },
    });
  }

  thinking(delta: string): void {
    this.serverFrame({
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text: delta }) } }) },
    });
  }

  tokens(count: number): void {
    this.serverFrame({
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens: count }) } }) },
    });
  }

  usage(usedTokens: number, maxTokens = 200000): void {
    this.serverFrame({
      message: {
        case: "conversationCheckpointUpdate",
        value: create(ConversationStateStructureSchema, {
          tokenDetails: create(ConversationTokenDetailsSchema, { usedTokens, maxTokens }),
        }),
      },
    });
  }

  turnEnded(): void {
    this.serverFrame({
      message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) } }) },
    });
  }

  execMcp(execMsgId: number, execId: string, toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    this.serverFrame({
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: execMsgId,
          execId,
          message: {
            case: "mcpArgs",
            value: create(McpArgsSchema, {
              name: `mcp_pi_${toolName}`,
              toolName,
              toolCallId,
              providerIdentifier: "pi",
              args: encodeArgs(args),
            }),
          },
        }),
      },
    });
  }

  execNativeRead(execMsgId: number, execId: string, path: string): void {
    this.serverFrame({
      message: {
        case: "execServerMessage",
        value: create(ExecServerMessageSchema, {
          id: execMsgId,
          execId,
          message: { case: "readArgs", value: create(ReadArgsSchema, { path, toolCallId: "t" }) },
        }),
      },
    });
  }

  kvGet(id: number, blobId: Uint8Array): void {
    this.serverFrame({
      message: {
        case: "kvServerMessage",
        value: create(KvServerMessageSchema, { id, message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId }) } }),
      },
    });
  }

  endStreamError(code: string, message: string): void {
    this.emit(encodeFrame(Buffer.from(JSON.stringify({ error: { code, message } }), "utf8"), true));
  }

  completeOk(): void {
    this.ended = true;
    this.endCb?.({ ok: true, status: 200 });
  }

  completeError(status: number, errorBody?: string): void {
    this.ended = true;
    this.endCb?.(transport.nextEnd ?? { ok: false, status, errorBody });
    transport.nextEnd = null;
  }

  transportError(message: string): void {
    this.destroyed = true;
    this.errorCb?.(new Error(message));
  }

  /** Client messages written so far, decoded. */
  clientMessages() {
    return this.written.map((frame) => fromBinary(AgentClientMessageSchema, frame.subarray(5)));
  }
}

// ── oneof narrowing helpers ────────────────────────────────────────────────

import type { AgentRunRequest, ExecClientMessage, KvClientMessage } from "../proto/agent_pb.js";

function runRequestOf(stream: FakeStream, index = 0): AgentRunRequest {
  const message = stream.clientMessages()[index].message;
  if (message.case !== "runRequest") throw new Error(`expected runRequest, got ${message.case}`);
  return message.value;
}

function execReplyOf(stream: FakeStream, index = 1): ExecClientMessage {
  const message = stream.clientMessages()[index].message;
  if (message.case !== "execClientMessage") throw new Error(`expected execClientMessage, got ${message.case}`);
  return message.value;
}

function kvReplyOf(stream: FakeStream, index = 1): KvClientMessage {
  const message = stream.clientMessages()[index].message;
  if (message.case !== "kvClientMessage") throw new Error(`expected kvClientMessage, got ${message.case}`);
  return message.value;
}

function actionTextOf(run: AgentRunRequest): string {
  const action = run.action?.action;
  if (action?.case !== "userMessageAction") throw new Error("expected userMessageAction");
  return action.value.userMessage?.text ?? "";
}

vi.mock("../transport/h2.js", () => ({
  openStream: (_baseUrl: string, options: { rpcPath: string; token: string }) => {
    if (transport.failOpen) throw transport.failOpen;
    const stream = new FakeStream(options);
    transport.streams.push(stream);
    return stream;
  },
  unaryRpc: vi.fn(),
  closeAllSessions: vi.fn(),
  describeTransportError: (_e: unknown, baseUrl: string) => `transport error on ${baseUrl}`,
}));

vi.mock("../auth/credentials.js", () => ({
  resolveAccessToken: vi.fn(async () => "fake-token"),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

const tools = [
  { name: "bash", description: "run shell", parameters: { type: "object", properties: { command: { type: "string" } } } },
] as unknown as Tool[];

function makeModel(id = "gpt-5"): Model<Api> {
  return {
    id,
    name: id,
    api: "cursor-native" as Api,
    provider: "cursor",
    baseUrl: "https://agentn.us.api5.cursor.sh",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    thinkingLevelMap: { off: null, low: `${id}-low`, medium: id, high: `${id}-high` },
  } as unknown as Model<Api>;
}

function makeContext(messages: Context["messages"], overrides: Partial<Context> = {}): Context {
  return { systemPrompt: "be helpful", messages, tools, ...overrides } as Context;
}

function user(text: string): Context["messages"][number] {
  return { role: "user", content: text, timestamp: Date.now() } as never;
}

function assistantToolCall(id: string, name: string, args: Record<string, unknown>): Context["messages"][number] {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: args }],
    api: "cursor-native",
    provider: "cursor",
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

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    if (event.type === "done" || event.type === "error") break;
  }
  return events;
}

function doneMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const done = events.find((event) => event.type === "done");
  if (!done) throw new Error(`no done event in: ${events.map((e) => e.type).join(",")}`);
  return (done as { message: AssistantMessage }).message;
}

function errorMessage(events: AssistantMessageEvent[]): AssistantMessage {
  const error = events.find((event) => event.type === "error");
  if (!error) throw new Error(`no error event in: ${events.map((e) => e.type).join(",")}`);
  return (error as { error: AssistantMessage }).error;
}

function lastStream(): FakeStream {
  const stream = transport.streams[transport.streams.length - 1];
  if (!stream) throw new Error("no stream opened");
  return stream;
}

const sessionId = "session-1";

function conversationIdFor(messages: Context["messages"], modelId = "gpt-5"): string {
  return buildConversationId(parseConversation(makeContext(messages)), modelId, sessionId);
}

beforeEach(() => {
  transport.streams = [];
  transport.nextEnd = null;
  transport.failOpen = null;
  clearAllBridges();
  clearAllUsage();
});

afterEach(() => {
  clearAllBridges();
  clearAllUsage();
  vi.clearAllMocks();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("parked bridge configuration", () => {
  it.each(["add tool", "remove tool", "schema", "description", "prompt", "reasoning", "credential"])("rebuilds the Run after a change to %s", async (change) => {
    const first = collect(streamCursor(makeModel(), makeContext([user("run")]), { apiKey: "t", sessionId, reasoning: "low" }));
    const parked = lastStream();
    parked.execMcp(1, "exec-1", "call_1", "bash", {});
    await first;
    let nextTools = tools;
    if (change === "add tool") nextTools = [...tools, { name: "new_tool", description: "new", parameters: { type: "object" } } as Tool];
    if (change === "remove tool") nextTools = [];
    if (change === "schema") nextTools = [{ ...tools[0], parameters: { type: "object", properties: { newArg: { type: "string" } } } } as Tool];
    if (change === "description") nextTools = [{ ...tools[0], description: "updated description" }];
    const context = makeContext([
      user("run"), assistantToolCall("call_1", "bash", {}), toolResult("call_1", "bash", "ok"),
    ], { tools: nextTools, systemPrompt: change === "prompt" ? "new instructions" : "be helpful" });
    const second = collect(streamCursor(makeModel(), context, {
      apiKey: change === "credential" ? "new-token" : "t", sessionId,
      reasoning: change === "reasoning" ? "high" : "low",
    }));
    const fresh = lastStream();
    fresh.turnEnded();
    await second;
    expect(parked.destroyed).toBe(true);
    expect(transport.streams).toHaveLength(2);
    const request = runRequestOf(fresh);
    expect(actionTextOf(request)).toBe("Continue.");
    expect(request.conversationState!.turns).toHaveLength(1);
    expect(request.mcpTools!.mcpTools.map(tool => tool.toolName)).toEqual(nextTools.map(tool => tool.name));
    expect(request.requestedModel!.modelId).toBe(change === "reasoning" ? "gpt-5-high" : "gpt-5-low");
  });
});

describe("streamCursor", () => {
  it("streams text deltas and finishes on turnEnded", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    expect(stream.options.rpcPath).toBe("/agent.v1.AgentService/Run");

    stream.text("Hello ");
    stream.text("world");
    stream.turnEnded();

    const events = await eventsPromise;
    const message = doneMessage(events);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
    expect(events.map((e) => e.type)).toContain("text_delta");
  });

  it("sends a run request with the action text and requested model", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("do the thing")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    const run = runRequestOf(stream);
    expect(actionTextOf(run)).toBe("do the thing");
    expect(run.requestedModel?.modelId).toBe("gpt-5");
    expect(run.conversationId).toBe(
      buildConversationId(parseConversation(makeContext([user("do the thing")])), "gpt-5", sessionId),
    );
    expect(run.mcpTools?.mcpTools[0].toolName).toBe("bash");
    stream.turnEnded();
    await eventsPromise;
  });

  it("routes the reasoning level to the mapped raw model id", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId, reasoning: "high" }));
    expect(runRequestOf(lastStream()).requestedModel?.modelId).toBe("gpt-5-high");
    lastStream().turnEnded();
    await eventsPromise;
  });

  it("clamps an unsupported level to the nearest supported raw id", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId, reasoning: "xhigh" }));
    expect(runRequestOf(lastStream()).requestedModel?.modelId).toBe("gpt-5-high");
    lastStream().turnEnded();
    await eventsPromise;
  });

  it("splits inline thinking tags out of text deltas", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.text("<thinking>pondering</thinking>answer");
    stream.turnEnded();

    const message = doneMessage(await eventsPromise);
    expect(message.content).toEqual([
      { type: "thinking", thinking: "pondering" },
      { type: "text", text: "answer" },
    ]);
  });

  it("routes dedicated thinking deltas to thinking blocks", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.thinking("deep ");
    stream.thinking("thought");
    stream.text("result");
    stream.turnEnded();

    const message = doneMessage(await eventsPromise);
    expect(message.content).toEqual([
      { type: "thinking", thinking: "deep thought" },
      { type: "text", text: "result" },
    ]);
  });

  it("publishes estimated usage when no prompt-size checkpoint arrives", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.text("x");
    stream.tokens(11);
    stream.tokens(7);
    stream.turnEnded();

    const message = doneMessage(await eventsPromise);
    expect(message.usage.input).toBeGreaterThan(0);
    expect(message.usage.output).toBe(18);
    expect(message.usage.totalTokens).toBe(message.usage.input + 18);
  });

  it("starts with estimated usage and replaces it when a checkpoint arrives", async () => {
    const events: AssistantMessageEvent[] = [];
    const eventsPromise = (async () => {
      for await (const event of streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId })) {
        events.push(event);
        if (event.type === "done" || event.type === "error") break;
      }
    })();
    const stream = lastStream();
    stream.text("x");
    stream.tokens(11);
    await vi.waitFor(() => expect(events.some((event) => event.type === "text_delta")).toBe(true));
    const before = events.filter((event) => event.type === "text_delta").at(-1) as { partial: AssistantMessage };
    expect(before.partial.usage.input).toBeGreaterThan(0);
    expect(before.partial.usage.output).toBe(11);
    expect(before.partial.usage.totalTokens).toBe(before.partial.usage.input + 11);

    stream.usage(80_000);
    stream.tokens(7);
    stream.text("y");
    await vi.waitFor(() => {
      const last = events.filter((event) => event.type === "text_delta").at(-1) as { partial: AssistantMessage } | undefined;
      expect(last?.partial.usage.input).toBe(80_000);
      expect(last?.partial.usage.output).toBe(18);
    });
    stream.turnEnded();
    await eventsPromise;
    const message = doneMessage(events);
    expect(message.usage.input).toBe(80_000);
    expect(message.usage.output).toBe(18);
    expect(message.usage.totalTokens).toBe(80_018);
  });

  it("rejects a one-off large checkpoint drop in the same conversation", async () => {
    const first = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const firstStream = lastStream();
    firstStream.usage(180_000);
    firstStream.text("first");
    firstStream.turnEnded();
    expect(doneMessage(await first).usage.input).toBe(180_000);

    const secondContext = makeContext([
      user("hi"),
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
        api: "cursor-native",
        provider: "cursor",
        model: "gpt-5",
        usage: { input: 180_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 180_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: Date.now(),
      } as never,
      user("next"),
    ]);
    const second = collect(streamCursor(makeModel(), secondContext, { apiKey: "t", sessionId }));
    const secondStream = lastStream();
    secondStream.usage(17_000);
    secondStream.text("second");
    secondStream.turnEnded();
    expect(doneMessage(await second).usage.input).toBe(180_000);
  });

  it("accepts a low checkpoint after compaction rotates the conversation", async () => {
    const before = collect(streamCursor(makeModel(), makeContext([user("original")]), { apiKey: "t", sessionId }));
    lastStream().usage(180_000);
    lastStream().turnEnded();
    await before;

    const compacted = makeContext([
      { role: "compactionSummary", summary: "short summary", timestamp: Date.now() } as never,
      user("continue"),
    ]);
    const after = collect(streamCursor(makeModel(), compacted, { apiKey: "t", sessionId }));
    lastStream().usage(20_000);
    lastStream().text("ok");
    lastStream().turnEnded();
    expect(doneMessage(await after).usage.input).toBe(20_000);
  });

  it("uses a low estimate after compaction when the first sub-turn has no checkpoint", async () => {
    const compactedAt = Date.now();
    const compacted = makeContext([
      {
        role: "user",
        content: "The conversation history before this point was compacted into the following summary:\n\n<summary>\nshort\n</summary>",
        timestamp: compactedAt,
      } as never,
      {
        role: "assistant",
        content: [{ type: "text", text: "kept old response" }],
        api: "cursor-native",
        provider: "cursor",
        model: "gpt-5",
        usage: { input: 180_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 180_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp: compactedAt - 1,
      } as never,
      user("continue"),
    ]);
    const result = collect(streamCursor(makeModel(), compacted, { apiKey: "t", sessionId }));
    lastStream().text("working");
    lastStream().turnEnded();
    const message = doneMessage(await result);
    expect(message.usage.input).toBeGreaterThan(0);
    expect(message.usage.input).toBeLessThan(100_000);
  });

  it("answers a KV blob request from the store", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    const blobId = runRequestOf(stream).conversationState!.rootPromptMessagesJson[0];
    stream.kvGet(42, blobId);

    // The answer is the second client frame (after the run request).
    await vi.waitFor(() => expect(stream.written.length).toBe(2));
    expect(kvReplyOf(stream).message.case).toBe("getBlobResult");
    stream.turnEnded();
    await eventsPromise;
  });

  it("rejects a native Cursor tool exec without ending the turn", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.execNativeRead(5, "exec-read", "/etc/hosts");

    await vi.waitFor(() => expect(stream.written.length).toBe(2));
    const reply = execReplyOf(stream);
    expect(reply.message.case).toBe("readResult");

    stream.text("used the mcp tool instead");
    stream.turnEnded();
    const message = doneMessage(await eventsPromise);
    expect(message.content).toEqual([{ type: "text", text: "used the mcp tool instead" }]);
  });

  it("parks a bridge and finalizes with toolUse on an MCP exec", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("run ls")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.text("running");
    stream.execMcp(9, "exec-1", "call_1", "bash", { command: "ls" });

    const events = await eventsPromise;
    const message = doneMessage(events);
    expect(message.stopReason).toBe("toolUse");
    expect(message.content).toEqual([
      { type: "text", text: "running" },
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
    ]);

    // The Run stream stays open, parked for the tool result.
    expect(stream.alive).toBe(true);
    const bridge = peekBridge(conversationIdFor([user("run ls")]));
    expect(bridge).toBeDefined();
    expect([...bridge!.pendingExecs.keys()]).toEqual(["call_1"]);
  });

  it("keeps estimated usage visible on toolUse without a checkpoint", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("run ls")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.tokens(11);
    stream.text("running");
    stream.execMcp(9, "exec-1", "call_1", "bash", { command: "ls" });

    const message = doneMessage(await eventsPromise);
    expect(message.stopReason).toBe("toolUse");
    expect(message.usage.input).toBeGreaterThan(0);
    expect(message.usage.output).toBe(11);
    expect(message.usage.totalTokens).toBe(message.usage.input + 11);
  });

  it("parks one turn with parallel MCP execs from the same tick", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("run")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.execMcp(1, "exec-1", "call_1", "bash", { command: "ls" });
    stream.execMcp(2, "exec-2", "call_2", "bash", { command: "pwd" });

    const message = doneMessage(await eventsPromise);
    expect(message.stopReason).toBe("toolUse");
    expect(message.content.filter((block) => block.type === "toolCall")).toEqual([
      { type: "toolCall", id: "call_1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "call_2", name: "bash", arguments: { command: "pwd" } },
    ]);
    expect([...peekBridge(conversationIdFor([user("run")]))!.pendingExecs.keys()]).toEqual(["call_1", "call_2"]);
  });

  it("surfaces a park-time transport error on the next call", async () => {
    const first = collect(streamCursor(makeModel(), makeContext([user("run")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.execMcp(1, "exec-1", "call_1", "bash", {});
    await first;
    stream.transportError("socket hang up");

    const resumed = makeContext([
      user("run"),
      assistantToolCall("call_1", "bash", {}),
      toolResult("call_1", "bash", "ok"),
    ]);
    const second = collect(streamCursor(makeModel(), resumed, { apiKey: "t", sessionId }));
    expect(transport.streams).toHaveLength(1);
    const message = errorMessage(await second);
    expect(message.errorMessage).toMatch(/socket hang up/);
  });

  it("resumes a parked bridge with the tool result inline", async () => {
    const context = makeContext([user("run ls")]);
    const first = collect(streamCursor(makeModel(), context, { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.execMcp(9, "exec-1", "call_1", "bash", { command: "ls" });
    await first;

    // Pi executed the tool; the next call carries the result.
    const resumedContext = makeContext([user("run ls"), assistantToolCall("call_1", "bash", { command: "ls" }), toolResult("call_1", "bash", "file.txt")]);
    const second = collect(streamCursor(makeModel(), resumedContext, { apiKey: "t", sessionId }));

    // No new stream: the exec answer went out on the parked one.
    expect(transport.streams).toHaveLength(1);
    await vi.waitFor(() => expect(stream.written.length).toBe(2));
    const answer = execReplyOf(stream);
    expect(answer.execId).toBe("exec-1");
    expect(answer.id).toBe(9);
    const mcpResult = answer.message;
    expect(mcpResult.case).toBe("mcpResult");
    if (mcpResult.case !== "mcpResult") throw new Error("expected mcpResult");
    expect(mcpResult.value.result.case).toBe("success");

    stream.text("done");
    stream.turnEnded();
    const message = doneMessage(await second);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "done" }]);
    expect(peekBridge(conversationIdFor([user("run ls")]))).toBeUndefined();
  });

  it("marks an errored tool result as an MCP error", async () => {
    const first = collect(streamCursor(makeModel(), makeContext([user("run")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.execMcp(3, "exec-2", "call_9", "bash", { command: "false" });
    await first;

    const resumed = makeContext([user("run"), assistantToolCall("call_9", "bash", { command: "false" }), toolResult("call_9", "bash", "exit 1", true)]);
    const second = collect(streamCursor(makeModel(), resumed, { apiKey: "t", sessionId }));
    await vi.waitFor(() => expect(stream.written.length).toBe(2));
    const mcpResult = execReplyOf(stream).message;
    if (mcpResult.case !== "mcpResult") throw new Error("expected mcpResult");
    expect(mcpResult.value.result.case).toBe("error");
    stream.turnEnded();
    await second;
  });

  it("rebuilds from context when no bridge can be resumed", async () => {
    // First turn parks a bridge...
    const first = collect(streamCursor(makeModel(), makeContext([user("run")]), { apiKey: "t", sessionId }));
    const parked = lastStream();
    parked.execMcp(1, "exec-1", "call_1", "bash", {});
    await first;

    // ...but the bridge dies before Pi returns with the result.
    parked.destroy();

    const resumed = makeContext([user("run"), assistantToolCall("call_1", "bash", {}), toolResult("call_1", "bash", "ok")]);
    const second = collect(streamCursor(makeModel(), resumed, { apiKey: "t", sessionId }));

    expect(transport.streams).toHaveLength(2);
    const fresh = lastStream();
    const run = runRequestOf(fresh);
    // The in-flight turn is folded into history and continued synthetically.
    expect(actionTextOf(run)).toBe("Continue.");
    expect(run.conversationState!.turns.length).toBe(1);

    fresh.text("recovered");
    fresh.turnEnded();
    expect(doneMessage(await second).content).toEqual([{ type: "text", text: "recovered" }]);
  });

  it("surfaces a connect end-stream error as an error event", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.text("partial");
    stream.endStreamError("internal", "model overloaded");

    const message = errorMessage(await eventsPromise);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("model overloaded");
    expect(stream.destroyed).toBe(true);
  });

  it("surfaces a non-2xx stream end", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    lastStream().completeError(401, "unauthenticated");

    const message = errorMessage(await eventsPromise);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toMatch(/401/);
    expect(message.errorMessage).toContain("unauthenticated");
  });

  it("surfaces a transport error", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    lastStream().transportError("GOAWAY");

    const message = errorMessage(await eventsPromise);
    expect(message.stopReason).toBe("error");
    expect(message.errorMessage).toContain("GOAWAY");
  });

  it("fails with a login hint when no token resolves", async () => {
    const { resolveAccessToken } = await import("../auth/credentials.js");
    vi.mocked(resolveAccessToken).mockResolvedValueOnce("");

    const events = await collect(streamCursor(makeModel(), makeContext([user("hi")]), { sessionId }));
    const message = errorMessage(events);
    expect(message.errorMessage).toMatch(/login cursor/i);
    expect(transport.streams).toHaveLength(0);
  });

  it("propagates a request-build failure", async () => {
    transport.failOpen = new Error("h2 is not supported");
    const events = await collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    expect(errorMessage(events).errorMessage).toContain("h2 is not supported");
  });

  it("reports aborted when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId, signal: controller.signal }));
    const stream = lastStream();
    stream.text("partial");
    controller.abort();

    const message = errorMessage(await eventsPromise);
    expect(message.stopReason).toBe("aborted");
    expect(stream.destroyed).toBe(true);
  });

  it("reports aborted when the signal is already fired", async () => {
    const controller = new AbortController();
    controller.abort();
    const events = await collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId, signal: controller.signal }));
    expect(errorMessage(events).stopReason).toBe("aborted");
    expect(transport.streams).toHaveLength(0);
  });

  it("closes a clean stream end as a stop", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.text("all done");
    stream.completeOk();

    const message = doneMessage(await eventsPromise);
    expect(message.stopReason).toBe("stop");
    expect(message.content).toEqual([{ type: "text", text: "all done" }]);
  });

  it("derives a stable conversation id without a session id", async () => {
    const first = collect(streamCursor(makeModel(), makeContext([user("same prompt")]), { apiKey: "t" }));
    const idA = runRequestOf(lastStream()).conversationId;
    lastStream().turnEnded();
    await first;

    const second = collect(streamCursor(makeModel(), makeContext([user("same prompt")]), { apiKey: "t" }));
    const idB = runRequestOf(lastStream()).conversationId;
    lastStream().turnEnded();
    await second;

    expect(idA).toBe(idB);
    expect(idA).toMatch(/^pi-[0-9a-f]{32}$/);
  });

  it("emits a start event before any content", async () => {
    const eventsPromise = collect(streamCursor(makeModel(), makeContext([user("hi")]), { apiKey: "t", sessionId }));
    const stream = lastStream();
    stream.text("x");
    stream.turnEnded();

    const events = await eventsPromise;
    expect(events[0].type).toBe("start");
  });
});
