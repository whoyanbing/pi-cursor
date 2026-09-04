/**
 * `streamCursor` — the Pi `streamSimple` implementation for Cursor's agent RPC.
 *
 * Per call, one of two things happens:
 *
 *   1. **Resume** — the trailing tool results answer the execs a parked bridge
 *      is waiting on, so they go inline on the still-open Run stream and the
 *      turn continues where it left off.
 *   2. **Fresh request** — the conversation is rebuilt from Pi's context
 *      (system prompt + completed turns as prompt-history blobs, in-flight
 *      turn folded in, synthetic "Continue." when resuming without a bridge)
 *      and sent over a new Run stream.
 *
 * When the server asks for an MCP tool mid-turn, the tool call is emitted into
 * the assistant message, the Pi stream finalizes with `toolUse`, and the Run
 * stream is parked as a bridge for the next call to answer.
 */
import { randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  StopReason,
  TextContent,
  ThinkingContent,
  ToolCall,
} from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ClientHeartbeatSchema,
  type McpToolDefinition,
} from "../proto/agent_pb.js";
import { CONTINUE_TEXT, RUN_RPC, getAgentUrl, heartbeatIntervalMs, streamIdleTimeoutMs } from "../config.js";
import { encodeFrame, FrameParser, parseErrorPayload } from "../transport/connect.js";
import { openStream, type RpcStream } from "../transport/h2.js";
import { resolveAccessToken } from "../auth/credentials.js";
import { resolveRouteTarget } from "../models/registry.js";
import { recordRun } from "../diagnostics.js";
import { BlobStore } from "./blobs.js";
import {
  destroyBridge,
  isBridgeExpired,
  bridgeMatchesResults,
  peekBridge,
  storeBridge,
  sweepBridges,
  takeBridge,
  type Bridge,
  type PendingExec,
} from "./bridge.js";
import { parseConversation, type ImagePart, type ParsedConversation, type ToolResultPayload } from "./context.js";
import { buildConversationId } from "./conversation-id.js";
import { encodeExecResult } from "./exec-result.js";
import { buildRunRequest, type ModelRouting } from "./request.js";
import { handleServerMessage, type ServerHandlers } from "./server.js";
import { ThinkingTagParser } from "./thinking.js";
import { buildToolDefinitions } from "./tools.js";

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Cost from per-million rates. Cursor is subscription-billed (zero rates), but
 * a locally computed cost keeps this independent of pi-ai's cost schema.
 */
function usageCost(model: Model<Api>, usage: AssistantMessage["usage"]): AssistantMessage["usage"]["cost"] {
  const rates = model.cost as
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    | undefined;
  if (!rates || typeof rates !== "object") {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  }
  const input = ((usage.input ?? 0) * (rates.input ?? 0)) / 1_000_000;
  const output = ((usage.output ?? 0) * (rates.output ?? 0)) / 1_000_000;
  const cacheRead = ((usage.cacheRead ?? 0) * (rates.cacheRead ?? 0)) / 1_000_000;
  const cacheWrite = ((usage.cacheWrite ?? 0) * (rates.cacheWrite ?? 0)) / 1_000_000;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}

/**
 * Owns one Pi assistant-message turn: accumulates content blocks, emits the
 * matching partial events, and finalizes with done/error exactly once.
 */
class TurnWriter {
  readonly output: AssistantMessage;
  private readonly parser = new ThinkingTagParser();
  private textIndex = -1;
  private thinkingIndex = -1;
  private started = false;
  private finalized = false;
  private emittedContent = false;
  /** Output deltas held until a real prompt-size checkpoint arrives. */
  private pendingOutputTokens = 0;

  constructor(
    private readonly model: Model<Api>,
    private readonly stream: AssistantMessageEventStream,
  ) {
    this.output = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    } as AssistantMessage;
  }

  get closed(): boolean {
    return this.finalized;
  }

  get hasContent(): boolean {
    return this.emittedContent;
  }

  setUsage(input: number, output: number): void {
    this.output.usage.input = Math.max(0, input);
    this.output.usage.output = Math.max(0, output);
    this.output.usage.totalTokens = this.output.usage.input + this.output.usage.output;
    this.output.usage.cost = usageCost(this.model, this.output.usage);
  }

  addOutputTokens(tokens: number): void {
    if (tokens <= 0) return;
    // Pi's footer treats the latest assistant `usage.totalTokens` as context
    // size. Publishing a handful of output tokens before the prompt-size
    // checkpoint makes the percentage flash to 0%. Hold them until input is known.
    if (this.output.usage.input <= 0) {
      this.pendingOutputTokens += tokens;
      return;
    }
    this.output.usage.output += tokens;
    this.output.usage.totalTokens = this.output.usage.input + this.output.usage.output;
  }

  setInputTokens(tokens: number): void {
    // A 0-token checkpoint is a keep-alive, not a real measurement.
    if (tokens <= 0) return;
    // Cursor sometimes sends a smaller follow-up checkpoint; never let usage
    // jump backwards on the same turn (that flashes the footer down).
    if (tokens < this.output.usage.input) return;
    this.output.usage.input = tokens;
    if (this.pendingOutputTokens > 0) {
      this.output.usage.output += this.pendingOutputTokens;
      this.pendingOutputTokens = 0;
    }
    this.output.usage.totalTokens = this.output.usage.input + this.output.usage.output;
    this.output.usage.cost = usageCost(this.model, this.output.usage);
  }

  /** Visible text; inline reasoning tags are split out into thinking blocks. */
  text(delta: string): void {
    const split = this.parser.process(delta);
    if (split.reasoning) this.thinking(split.reasoning);
    if (split.content) this.appendText(split.content);
  }

  thinking(delta: string): void {
    this.appendThinking(delta);
  }

  toolCall(call: PendingExec): void {
    this.ensureStart();
    this.closeThinking();
    this.closeText();
    const contentIndex = this.output.content.length;
    const toolCall: ToolCall = {
      type: "toolCall",
      id: call.toolCallId,
      name: call.toolName,
      arguments: call.arguments as Record<string, never>,
    };
    this.output.content.push(toolCall);
    this.stream.push({ type: "toolcall_start", contentIndex, partial: this.output });
    this.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: this.output });
    this.emittedContent = true;
  }

  finish(reason: StopReason, errorMessage?: string): void {
    if (this.finalized) return;
    const flushed = this.parser.flush();
    if (flushed.reasoning) this.appendThinking(flushed.reasoning);
    if (flushed.content) this.appendText(flushed.content);
    this.closeThinking();
    this.closeText();
    this.flushPendingOutput();
    this.finalized = true;
    this.output.stopReason = reason;
    if (errorMessage) this.output.errorMessage = errorMessage;
    this.output.usage.cost = usageCost(this.model, this.output.usage);
    if (reason === "error" || reason === "aborted") {
      this.stream.push({ type: "error", reason, error: this.output });
    } else {
      this.stream.push({ type: "done", reason: reason as "stop" | "length" | "toolUse" | "deferred", message: this.output });
    }
    try {
      this.stream.end();
    } catch {
      // Already ended.
    }
  }

  private ensureStart(): void {
    if (this.started) return;
    this.started = true;
    this.stream.push({ type: "start", partial: this.output });
  }

  private appendText(delta: string): void {
    this.ensureStart();
    this.closeThinking();
    if (this.textIndex < 0) {
      this.textIndex = this.output.content.length;
      this.output.content.push({ type: "text", text: "" } as TextContent);
      this.stream.push({ type: "text_start", contentIndex: this.textIndex, partial: this.output });
    }
    const block = this.output.content[this.textIndex] as TextContent;
    block.text += delta;
    this.stream.push({ type: "text_delta", contentIndex: this.textIndex, delta, partial: this.output });
    this.emittedContent = true;
  }

  private appendThinking(delta: string): void {
    this.ensureStart();
    this.closeText();
    if (this.thinkingIndex < 0) {
      this.thinkingIndex = this.output.content.length;
      this.output.content.push({ type: "thinking", thinking: "" } as ThinkingContent);
      this.stream.push({ type: "thinking_start", contentIndex: this.thinkingIndex, partial: this.output });
    }
    const block = this.output.content[this.thinkingIndex] as ThinkingContent;
    block.thinking += delta;
    this.stream.push({ type: "thinking_delta", contentIndex: this.thinkingIndex, delta, partial: this.output });
    this.emittedContent = true;
  }

  private closeText(): void {
    if (this.textIndex < 0) return;
    const block = this.output.content[this.textIndex] as TextContent;
    this.stream.push({ type: "text_end", contentIndex: this.textIndex, content: block.text, partial: this.output });
    this.textIndex = -1;
  }

  private closeThinking(): void {
    if (this.thinkingIndex < 0) return;
    const block = this.output.content[this.thinkingIndex] as ThinkingContent;
    this.stream.push({ type: "thinking_end", contentIndex: this.thinkingIndex, content: block.thinking, partial: this.output });
    this.thinkingIndex = -1;
  }

  private flushPendingOutput(): void {
    // Without a prompt-size checkpoint, leave usage at 0 so Pi's footer keeps
    // using the previous assistant. Flushing a few output tokens here is what
    // made the context percentage jump to 0% on tool calls.
    if (this.pendingOutputTokens <= 0 || this.output.usage.input <= 0) return;
    this.output.usage.output += this.pendingOutputTokens;
    this.pendingOutputTokens = 0;
    this.output.usage.totalTokens = this.output.usage.input + this.output.usage.output;
  }
}

interface RunState {
  bridge: Bridge | null;
  writer: TurnWriter | null;
  outputTokens: number;
  lastWorkAt: number;
  watchdog: ReturnType<typeof setInterval> | null;
}

function heartbeatFrame(): Uint8Array {
  return encodeFrame(
    toBinary(
      AgentClientMessageSchema,
      create(AgentClientMessageSchema, {
        message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
      }),
    ),
  );
}

function startHeartbeat(bridge: Bridge): void {
  const interval = heartbeatIntervalMs();
  if (bridge.heartbeatTimer || interval <= 0) return;
  bridge.heartbeatTimer = setInterval(() => {
    if (!bridge.rpc.alive) {
      if (bridge.heartbeatTimer) clearInterval(bridge.heartbeatTimer);
      bridge.heartbeatTimer = null;
      return;
    }
    try {
      bridge.rpc.write(heartbeatFrame());
    } catch {
      // A failed heartbeat is surfaced by the transport error path.
    }
  }, interval);
  bridge.heartbeatTimer.unref?.();
}

function armWatchdog(state: RunState, onTimeout: () => void): void {
  const timeout = streamIdleTimeoutMs();
  if (state.watchdog) clearInterval(state.watchdog);
  if (timeout <= 0) {
    state.watchdog = null;
    return;
  }
  state.lastWorkAt = Date.now();
  state.watchdog = setInterval(() => {
    if (Date.now() - state.lastWorkAt > timeout) {
      if (state.watchdog) clearInterval(state.watchdog);
      state.watchdog = null;
      onTimeout();
    }
  }, Math.min(5000, timeout));
  state.watchdog.unref?.();
}

function stopWatchdog(state: RunState): void {
  if (state.watchdog) clearInterval(state.watchdog);
  state.watchdog = null;
}

/** Park the bridge: finalize the writer with toolUse and wait for Pi's results. */
function parkBridge(state: RunState): void {
  const writer = state.writer;
  const bridge = state.bridge;
  if (bridge) {
    bridge.pausedAt = Date.now();
    bridge.sink = null;
    startHeartbeat(bridge);
  }
  state.writer = null;
  stopWatchdog(state);
  if (writer && !writer.closed) writer.finish("toolUse");
}

function dropBridge(state: RunState): void {
  stopWatchdog(state);
  if (state.bridge) {
    // Unregister too: a finished turn must not be resumable. Only drop the
    // registry slot when it still points at this bridge.
    if (peekBridge(state.bridge.conversationId) === state.bridge) {
      takeBridge(state.bridge.conversationId);
    }
    destroyBridge(state.bridge);
  }
  state.bridge = null;
}
/**
 * Wire transport + protocol handlers to the current run state.
 * RpcStream.onData / onEnd / onError assign (they do not stack); calling this
 * again on resume replaces the previous handlers rather than duplicating them.
 */
function attachTransport(state: RunState): void {
  const bridge = state.bridge!;

  bridge.rpc.onData((chunk) => {
    let frames;
    try {
      frames = bridge.parser.push(chunk);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dropBridge(state);
      state.writer?.finish("error", message);
      return;
    }
    for (const frame of frames) {
      if (frame.endStream) {
        const err = parseErrorPayload(frame.payload);
        dropBridge(state);
        state.writer?.finish("error", err.message || err.code || "Cursor ended the stream with an error");
        return;
      }
      try {
        handleServerMessage(frame.payload, makeHandlers(state));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        dropBridge(state);
        state.writer?.finish("error", `Cursor stream handling failed: ${message}`);
        return;
      }
    }
  });

  bridge.rpc.onEnd((info) => {
    if (!info.ok) {
      const detail = info.statusText || info.errorBody || "request failed";
      dropBridge(state);
      state.writer?.finish("error", `Cursor RPC failed: HTTP ${info.status} ${detail}`);
      return;
    }
    // Clean end without turnEnded: if a writer is live, close it out. A parked
    // bridge whose stream ended cannot be resumed — drop it silently; the next
    // call rebuilds from context.
    if (state.writer) {
      dropBridge(state);
      state.writer.finish("stop");
    } else {
      dropBridge(state);
    }
  });

  bridge.rpc.onError((error) => {
    dropBridge(state);
    state.writer?.finish("error", error.message);
  });
}

function makeHandlers(state: RunState): ServerHandlers {
  const bridge = state.bridge!;
  const markWork = (): void => {
    state.lastWorkAt = Date.now();
  };

  return {
    blobs: bridge.blobs,
    toolDefinitions: bridge.toolDefinitions,
    onText(text) {
      markWork();
      state.writer?.text(text);
    },
    onThinking(text) {
      markWork();
      state.writer?.thinking(text);
    },
    onTokenDelta(tokens) {
      markWork();
      state.outputTokens += tokens;
      state.writer?.addOutputTokens(tokens);
    },
    onUsage(usedTokens) {
      markWork();
      state.writer?.setInputTokens(usedTokens);
    },
    onTurnEnded() {
      markWork();
      recordRun({ lastTurnEndedAt: Date.now() });
      dropBridge(state);
      state.writer?.finish("stop");
    },
    onToolCall(call) {
      markWork();
      const pending: PendingExec = { ...call, surfaced: false };
      bridge.pendingExecs.set(call.toolCallId, pending);
      const writer = state.writer;
      if (writer && !writer.closed) {
        pending.surfaced = true;
        writer.toolCall(pending);
        parkBridge(state);
      }
      // No live writer (arrived after a pause): stays pending and is surfaced
      // when the next call resumes the bridge.
    },
    onError(message) {
      dropBridge(state);
      state.writer?.finish("error", message);
    },
    onLiveness() {
      markWork();
    },
    send(clientMessage) {
      markWork();
      bridge.rpc.write(encodeFrame(toBinary(AgentClientMessageSchema, clientMessage as never)));
    },
  };
}

function stableConversationId(options: SimpleStreamOptions | undefined, parsed: ParsedConversation, modelId: string): string {
  return buildConversationId(parsed, modelId, options?.sessionId);
}

function collectToolResults(parsed: ParsedConversation): Map<string, ToolResultPayload> {
  const results = new Map<string, ToolResultPayload>();
  for (const turn of parsed.completedTurns) {
    for (const step of turn.steps) {
      if (step.kind === "toolCall" && step.result) results.set(step.toolCallId, step.result);
    }
  }
  return results;
}

export function streamCursor(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const writer = new TurnWriter(model, stream);
  // Shared with the abort listener below; assigned once the run state exists.
  let state: RunState | null = null;

  const abortRun = (): void => {
    if (writer.closed) return;
    if (state) dropBridge(state);
    writer.finish("aborted", "Aborted");
  };
  if (options?.signal) {
    if (options.signal.aborted) {
      writer.finish("aborted", "Aborted");
      return stream;
    }
    options.signal.addEventListener("abort", abortRun, { once: true });
  }

  void (async () => {
    try {
      const parsed = parseConversation(context);
      const toolDefinitions = buildToolDefinitions(context.tools);
      const conversationId = stableConversationId(options, parsed, model.id);
      const token = options?.apiKey?.trim() || (await resolveAccessToken());
      if (writer.closed) return;
      if (!token) {
        throw new Error("Not logged in to Cursor. Run /login cursor, or set CURSOR_ACCESS_TOKEN.");
      }
      const routing = resolveRouting(model, options);
      const baseUrl = getAgentUrl();

      sweepBridges();

      const existing = takeBridge(conversationId);
      if (existing) {
        const resumable =
          parsed.isToolContinuation &&
          !isBridgeExpired(existing) &&
          existing.rpc.alive &&
          bridgeMatchesResults(existing, parsed.answeredToolCallIds);
        if (resumable) {
          state = { bridge: existing, writer, outputTokens: 0, lastWorkAt: Date.now(), watchdog: null };
          resumeBridge(state, parsed);
          return;
        }
        destroyBridge(existing);
      }

      state = { bridge: null, writer, outputTokens: 0, lastWorkAt: Date.now(), watchdog: null };
      startFresh(state, parsed, toolDefinitions, conversationId, token, baseUrl, routing);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordRun({ lastError: message });
      if (state) dropBridge(state);
      writer.finish("error", message);
    }
  })();

  return stream;
}

function resolveRouting(model: Model<Api>, options: SimpleStreamOptions | undefined): ModelRouting {
  const level = options?.reasoning;
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
  let levelRawId: string | undefined;
  if (level && map) {
    const mapped = map[level];
    // Thinking-level map values are raw Cursor ids; null means unsupported.
    if (typeof mapped === "string" && mapped) levelRawId = mapped;
  }
  const target = resolveRouteTarget(model.id, levelRawId);
  return { modelId: target.modelId, maxMode: target.maxMode, parameters: target.parameters };
}

function startFresh(
  state: RunState,
  parsed: ParsedConversation,
  toolDefinitions: McpToolDefinition[],
  conversationId: string,
  token: string,
  baseUrl: string,
  routing: ModelRouting,
): void {
  const actionText = parsed.action.kind === "userMessage" ? parsed.action.text : CONTINUE_TEXT;
  const actionImages: readonly ImagePart[] = parsed.action.kind === "userMessage" ? parsed.action.images : [];

  const built = buildRunRequest({
    systemPrompt: parsed.systemPrompt,
    completedTurns: parsed.completedTurns,
    actionText,
    actionImages,
    toolDefinitions,
    routing,
    conversationId,
  });

  const rpc = openStream(baseUrl, { rpcPath: RUN_RPC, token });
  const bridge: Bridge = {
    rpc,
    parser: new FrameParser(),
    blobs: built.blobs,
    toolDefinitions,
    pendingExecs: new Map(),
    conversationId,
    baseUrl,
    pausedAt: Date.now(),
    heartbeatTimer: null,
    sink: null,
  };
  state.bridge = bridge;
  storeBridge(conversationId, bridge);
  recordRun({ lastEndpoint: baseUrl, lastRpcPath: RUN_RPC, lastRequestBytes: built.bytes.byteLength });

  attachTransport(state);
  armWatchdog(state, () => {
    dropBridge(state);
    state.writer?.finish("error", `Cursor stream idle timeout after ${streamIdleTimeoutMs()}ms without upstream progress`);
  });
  startHeartbeat(bridge);

  rpc.write(encodeFrame(built.bytes));
}

function writerActive(state: RunState): boolean {
  return state.writer !== null && !state.writer.closed;
}
void writerActive;

function resumeBridge(state: RunState, parsed: ParsedConversation): void {
  const bridge = state.bridge!;
  bridge.sink = null;
  bridge.pausedAt = Date.now();
  storeBridge(bridge.conversationId, bridge);

  const results = collectToolResults(parsed);
  for (const toolCallId of parsed.answeredToolCallIds) {
    const exec = bridge.pendingExecs.get(toolCallId);
    if (!exec) continue;
    const payload = results.get(toolCallId) ?? { content: "", images: [], isError: false };
    bridge.rpc.write(encodeFrame(encodeExecResult(exec.execMsgId, exec.execId, payload)));
    bridge.pendingExecs.delete(toolCallId);
  }

  // Execs that arrived after the previous message finalized were never shown
  // to Pi. Surface them now so this turn's message carries them.
  const unsurfaced = [...bridge.pendingExecs.values()].filter((exec) => !exec.surfaced);
  if (unsurfaced.length > 0 && state.writer) {
    for (const exec of unsurfaced) {
      exec.surfaced = true;
      state.writer.toolCall(exec);
    }
    parkBridge(state);
    return;
  }

  attachTransport(state);
  armWatchdog(state, () => {
    dropBridge(state);
    state.writer?.finish("error", `Cursor stream idle timeout after ${streamIdleTimeoutMs()}ms without upstream progress`);
  });
  startHeartbeat(bridge);
}

/** Test/diagnostic helper: a stable random id. */
export function newRequestId(): string {
  return randomUUID();
}
