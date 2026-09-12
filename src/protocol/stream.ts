/**
 * `streamCursor` — the Pi `streamSimple` implementation for Cursor's agent RPC.
 *
 * Every call is stateless: the conversation is rebuilt from Pi's context
 * (system prompt + completed turns as prompt-history blobs, in-flight turn
 * folded in, synthetic "Continue." after tool results) and sent over a new
 * Run stream. When the server asks for an MCP tool mid-turn, the tool call is
 * emitted into the assistant message, the Pi stream finalizes with `toolUse`,
 * and this Run stream is torn down — the next call carries the tool results
 * as replayed history.
 */
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions, StopReason, TextContent, ThinkingContent, ToolCall } from "@earendil-works/pi-ai";
import { clampThinkingLevel, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { create } from "@bufbuild/protobuf";
import { AgentClientMessageSchema, ClientHeartbeatSchema, type AgentClientMessage, type McpToolDefinition } from "../proto/agent_pb.js";
import { openRun, type RunStream } from "../transport/client.js";
import { CONTINUE_TEXT, getAgentUrl, heartbeatIntervalMs, streamIdleTimeoutMs } from "../config.js";
import { resolveAccessToken } from "../auth/credentials.js";
import { resolveRouteTarget } from "../models/registry.js";
import { recordRun } from "../diagnostics.js";
import { parseConversation, type ImagePart, type ParsedConversation } from "./context.js";
import { buildConversationId } from "./conversation-id.js";
import { buildRunRequest, type ModelRouting } from "./request.js";
import { handleServerMessage, type ServerHandlers } from "./server.js";
import { ThinkingTagParser } from "./thinking.js";
import { buildToolDefinitions } from "./tools.js";
import { cachedInputTokens, contextInputTokens, estimatePromptTokens, stabilizeInputTokens } from "./usage.js";
import { resolveWorkspaceCwd } from "../workspace.js";
import type { BlobStore } from "./blobs.js";
interface PendingExec { execMsgId: number; execId: string; toolCallId: string; toolName: string; arguments: Record<string, unknown>; surfaced: boolean; }
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
  private hasPromptCheckpoint = false;
  /** Output deltas held until either a fallback seed or a real checkpoint arrives. */
  private pendingOutputTokens = 0;

  constructor(
    private readonly model: Model<Api>,
    private readonly stream: AssistantMessageEventStream,
    private readonly onClosed?: () => void,
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

  /** Seed a visible, non-zero usage while Cursor has not sent a checkpoint. */
  seedInputTokens(tokens: number): void {
    if (tokens <= 0 || this.output.usage.input > 0) return;
    this.setUsage(tokens, 0);
    this.flushPendingOutput();
    this.ensureStart();
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
    // The first real checkpoint replaces the fallback estimate even if smaller.
    // Later checkpoints on the same turn must remain monotonic.
    if (this.hasPromptCheckpoint && tokens < this.output.usage.input) return;
    this.hasPromptCheckpoint = true;
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
    this.finalized = true;
    this.onClosed?.();
    const flushed = this.parser.flush();
    if (flushed.reasoning) this.appendThinking(flushed.reasoning);
    if (flushed.content) this.appendText(flushed.content);
    this.closeThinking();
    this.closeText();
    this.flushPendingOutput();
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

interface RunState { rpc: RunStream; blobs: BlobStore; toolDefinitions: McpToolDefinition[]; pendingExecs: Map<string, PendingExec>; conversationId: string; heartbeatTimer: ReturnType<typeof setInterval> | null; writer: TurnWriter | null; outputTokens: number; lastWorkAt: number; watchdog: ReturnType<typeof setInterval> | null; toolCallQueued: boolean; startedAt: number; }
function newRunState(writer: TurnWriter, rpc: RunStream, blobs: BlobStore, toolDefinitions: McpToolDefinition[], conversationId: string, startedAt: number): RunState { return { rpc, blobs, toolDefinitions, pendingExecs: new Map(), conversationId, heartbeatTimer: null, writer, outputTokens: 0, lastWorkAt: Date.now(), watchdog: null, toolCallQueued: false, startedAt }; }

function markFirstOutput(state: RunState): void {
  if (state.startedAt <= 0) return;
  recordRun({ lastFirstTokenMs: Date.now() - state.startedAt });
  state.startedAt = 0;
}

const RUN_RPC = "agent.v1.AgentService/Run";

function heartbeatMessage(): AgentClientMessage {
  return create(AgentClientMessageSchema, {
    message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) },
  });
}

function startHeartbeat(state: RunState): void { const interval = heartbeatIntervalMs(); if (state.heartbeatTimer || interval <= 0) return; state.heartbeatTimer = setInterval(() => { if (!state.rpc.alive) { stopHeartbeat(state); return; } try { state.rpc.send(heartbeatMessage()); } catch { } }, interval); state.heartbeatTimer.unref?.(); }
function stopHeartbeat(state: RunState): void { if (state.heartbeatTimer) clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }

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

function endRun(state: RunState): void { stopWatchdog(state); stopHeartbeat(state); try { state.rpc.destroy(); } catch { } }
function finishToolUse(state: RunState): void { const writer = state.writer; state.writer = null; endRun(state); if (writer && !writer.closed) writer.finish("toolUse"); }
function flushPendingToolCalls(state: RunState): void { const writer = state.writer; if (!writer || writer.closed) return; const batch = [...state.pendingExecs.values()].filter((exec) => !exec.surfaced); if (batch.length === 0) return; for (const exec of batch) { exec.surfaced = true; writer.toolCall(exec); } finishToolUse(state); }
function queueToolCalls(state: RunState): void { if (state.toolCallQueued) return; if (!state.writer || state.writer.closed) return; state.toolCallQueued = true; queueMicrotask(() => { state.toolCallQueued = false; flushPendingToolCalls(state); }); }
function failRun(state: RunState, message: string): void { recordRun({ lastError: message }); const writer = state.writer; state.writer = null; endRun(state); if (writer && !writer.closed) writer.finish("error", message); }
/**
 * Wire transport + protocol handlers to the current run state.
 * RunStream.onMessage / onEnd / onError assign (they do not stack).
 */
function attachTransport(state: RunState): void { const handlers = makeHandlers(state); state.rpc.onMessage((message) => { try { handleServerMessage(message, handlers); } catch (error) { failRun(state, `Cursor stream handling failed: ${error instanceof Error ? error.message : String(error)}`); } }); state.rpc.onEnd(() => { if (state.writer) { const writer = state.writer; state.writer = null; endRun(state); writer.finish("stop"); } else { failRun(state, "Cursor ended the stream before the turn completed."); } }); state.rpc.onError((error) => { failRun(state, error.message); }); }

function makeHandlers(state: RunState): ServerHandlers { const markWork = (): void => { state.lastWorkAt = Date.now(); }; return { blobs: state.blobs, toolDefinitions: state.toolDefinitions, onText(text) { markWork(); markFirstOutput(state); state.writer?.text(text); }, onThinking(text) { markWork(); markFirstOutput(state); state.writer?.thinking(text); }, onTokenDelta(tokens) { markWork(); state.outputTokens += tokens; state.writer?.addOutputTokens(tokens); }, onUsage(usedTokens) { markWork(); state.writer?.setInputTokens(stabilizeInputTokens(state.conversationId, usedTokens)); }, onTurnEnded() { markWork(); recordRun({ lastTurnEndedAt: Date.now() }); if (state.writer) { const writer = state.writer; state.writer = null; endRun(state); writer.finish("stop"); } else { failRun(state, "Cursor ended the turn with no live writer."); } }, onToolCall(call) { markWork(); markFirstOutput(state); state.pendingExecs.set(call.toolCallId, { ...call, surfaced: false }); if (state.writer && !state.writer.closed) queueToolCalls(state); }, onError(message) { failRun(state, message); }, onLiveness() { markWork(); }, send(clientMessage) { markWork(); state.rpc.send(clientMessage); } }; }

export function streamCursor(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  let state: RunState | null = null;
  let writer: TurnWriter;
  const abortRun = (): void => { if (writer.closed) return; if (state) endRun(state); writer.finish("aborted", "Aborted"); };
  writer = new TurnWriter(model, stream, () => {
    options?.signal?.removeEventListener("abort", abortRun);
  });
  if (options?.signal) {
    if (options.signal.aborted) {
      writer.finish("aborted", "Aborted");
      return stream;
    }
    options.signal.addEventListener("abort", abortRun, { once: true });
  }

  const startedAt = Date.now();
  void (async () => {
    try {
      const parsed = parseConversation(context);
      // Cursor protocol has no tool-choice flag; none means send no tools at all.
      const toolDefinitions = options?.toolChoice === "none" ? [] : buildToolDefinitions(context.tools);
      const conversationId = buildConversationId(parsed, model.id, options?.sessionId);
      const priorInput = contextInputTokens(context, model);
      if (priorInput > 0) stabilizeInputTokens(conversationId, priorInput);
      // A real checkpoint from the previous sub-turn beats a character-count
      // estimate, and skipping the estimate avoids re-serializing the history.
      const initialInput = cachedInputTokens(conversationId) || estimatePromptTokens(model, context, parsed);
      writer.seedInputTokens(initialInput);
      const token = options?.apiKey?.trim() || (await resolveAccessToken(options?.signal));
      if (writer.closed) return;
      if (!token) {
        throw new Error("Not logged in to Cursor. Run /login cursor, or set CURSOR_ACCESS_TOKEN.");
      }
      const { routing, rawId } = resolveRouting(model, options);
      // pi-ai<0.85 lacks the field; pi>=0.85 reads it for the thinking badge.
      (writer.output as { providerThinkingLevel?: string }).providerThinkingLevel = rawId;
      const baseUrl = getAgentUrl();
      const actionText = parsed.action.kind === "userMessage" ? parsed.action.text : CONTINUE_TEXT;
      const actionImages: readonly ImagePart[] = parsed.action.kind === "userMessage" ? parsed.action.images : [];
      const built = buildRunRequest({ systemPrompt: parsed.systemPrompt, completedTurns: parsed.completedTurns, actionText, actionImages, toolDefinitions, routing, conversationId, workspaceCwd: resolveWorkspaceCwd(options?.sessionId) });
      state = newRunState(writer, openRun(baseUrl, token), built.blobs, toolDefinitions, conversationId, startedAt);
      recordRun({ lastEndpoint: baseUrl, lastRpcPath: RUN_RPC, lastRequestBytes: built.bytes });
      attachTransport(state);
      armWatchdog(state, () => { failRun(state!, `Cursor stream idle timeout after ${streamIdleTimeoutMs()}ms without upstream progress`); });
      startHeartbeat(state);
      state.rpc.send(built.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      recordRun({ lastError: message });
      if (state) endRun(state);
      writer.finish("error", message);
    }
  })();

  return stream;
}

function resolveRouting(
    model: Model<Api>,
    options: SimpleStreamOptions | undefined,
  ): { routing: ModelRouting; rawId: string } {
  const requested = options?.reasoning;
  const clamped = requested ? clampThinkingLevel(model, requested) : undefined;
  const level = clamped === "off" ? undefined : clamped;
  const map = model.thinkingLevelMap as Record<string, string | null> | undefined;
  let levelRawId: string | undefined;
  if (level && map) {
    const mapped = map[level];
    // Thinking-level map values are raw Cursor ids; null means unsupported.
    if (typeof mapped === "string" && mapped) levelRawId = mapped;
  }
  const target = resolveRouteTarget(model.id, levelRawId);
  return {
    routing: { modelId: target.modelId, maxMode: target.maxMode, parameters: target.parameters },
    rawId: target.modelId,
  };
}
