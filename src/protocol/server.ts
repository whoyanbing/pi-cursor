/**
 * Handles `AgentServerMessage` frames arriving on the Run stream.
 *
 * The server drives the turn from here: it streams text/thinking deltas, pulls
 * blobs it was given ids for (KV channel), asks the client to execute MCP tools
 * or rejects Cursor-native tools (exec channel), and occasionally asks an
 * interaction question. Each case either produces output for Pi or writes an
 * answer frame back on the same stream.
 */
import { create, fromBinary, toBinary, type DescMessage } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  AskQuestionErrorSchema,
  AskQuestionInteractionResponseSchema,
  AskQuestionResultSchema,
  BackgroundShellSpawnErrorSchema,
  BackgroundShellSpawnResultSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DiagnosticsRejectedSchema,
  DiagnosticsResultSchema,
  ExecClientControlMessageSchema,
  ExecClientMessageSchema,
  ExecClientThrowSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  InteractionResponseSchema,
  KvClientMessageSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesRejectedSchema,
  LsRejectedSchema,
  LsResultSchema,
  McpResultSchema,
  McpToolNotFoundSchema,
  ReadMcpResourceExecResultSchema,
  ReadMcpResourceRejectedSchema,
  ReadRejectedSchema,
  ReadResultSchema,
  RequestContextSchema,
  RequestContextResultSchema,
  RequestContextSuccessSchema,
  RecordScreenFailureSchema,
  RecordScreenResultSchema,
  SetBlobResultSchema,
  ShellRejectedSchema,
  ShellResultSchema,
  ShellStreamSchema,
  WebSearchRequestResponseSchema,
  WebSearchRequestResponse_RejectedSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  type McpToolDefinition,
} from "../proto/agent_pb.js";
import { recordRun } from "../diagnostics.js";
import { decodeArgs } from "./request.js";
import type { BlobStore } from "./blobs.js";
import { piToolName } from "./prompt.js";
import { findWebTool, nativeToolRejection } from "./tools.js";

export interface PendingToolCall {
  execMsgId: number;
  execId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface ServerHandlers {
  readonly blobs: BlobStore;
  readonly toolDefinitions: McpToolDefinition[];
  onText(text: string): void;
  onThinking(text: string): void;
  onTokenDelta(tokens: number): void;
  onTurnEnded(): void;
  onUsage(usedTokens: number): void;
  onToolCall(call: PendingToolCall): void;
  onError(message: string): void;
  /** Heartbeats and other liveness-only frames. */
  onLiveness(): void;
  /** Write an answer frame back on the Run stream. */
  send(message: ReturnType<typeof createClientMessage>): void;
}

function createClientMessage(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]) {
  return create(AgentClientMessageSchema, message);
}

export function encodeClientMessage(message: unknown): Uint8Array {
  return toBinary(AgentClientMessageSchema, message as never);
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function answerExec(
  h: ServerHandlers,
  execMsgId: number,
  execId: string,
  message: Record<string, unknown>,
): void {
  h.send(
    createClientMessage({
      message: {
        case: "execClientMessage",
        value: create(ExecClientMessageSchema, { id: execMsgId, execId, message: message as never }),
      },
    }),
  );
}

/** Answer a KV blob request from the server. */
function handleKv(h: ServerHandlers, id: number, message: { case: string; value: unknown }): void {
  if (message.case === "getBlobArgs") {
    const args = message.value as { blobId: Uint8Array };
    const data = h.blobs.getByIdBytes(args.blobId);
    h.send(
      createClientMessage({
        message: {
          case: "kvClientMessage",
          value: create(KvClientMessageSchema, {
            id,
            message: {
              case: "getBlobResult",
              value: create(GetBlobResultSchema, data ? { blobData: data } : {}),
            },
          }),
        },
      }),
    );
    return;
  }
  if (message.case === "setBlobArgs") {
    const args = message.value as { blobId: Uint8Array; blobData: Uint8Array };
    h.blobs.setFromServer(args.blobId, args.blobData);
    h.send(
      createClientMessage({
        message: {
          case: "kvClientMessage",
          value: create(KvClientMessageSchema, {
            id,
            message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) },
          }),
        },
      }),
    );
  }
}

function toolNames(h: ServerHandlers): Set<string> {
  return new Set(h.toolDefinitions.map((tool) => tool.toolName));
}

type Args = Record<string, unknown>;
const str = (value: unknown): string => String(value ?? "");
const pathReason = (a: Args, reason: string) => ({ path: str(a.path), reason });
const shellReason = (a: Args, reason: string) => ({
  command: str(a.command),
  workingDirectory: str(a.workingDirectory),
  reason,
  isReadonly: false,
});

/**
 * How to reject each Cursor-native exec: which `ExecClientMessage` case to
 * answer with, its result schema, the oneof to fill (`result` unless noted),
 * the rejection case inside it, and the rejection message + fields.
 */
interface RejectSpec {
  result: string;
  schema: DescMessage;
  oneof?: string;
  reject: string;
  inner: DescMessage;
  fields: (args: Args, reason: string) => Record<string, unknown>;
}

const NATIVE_REJECTS: Record<string, RejectSpec> = {
  readArgs: { result: "readResult", schema: ReadResultSchema, reject: "rejected", inner: ReadRejectedSchema, fields: pathReason },
  lsArgs: { result: "lsResult", schema: LsResultSchema, reject: "rejected", inner: LsRejectedSchema, fields: pathReason },
  writeArgs: { result: "writeResult", schema: WriteResultSchema, reject: "rejected", inner: WriteRejectedSchema, fields: pathReason },
  deleteArgs: { result: "deleteResult", schema: DeleteResultSchema, reject: "rejected", inner: DeleteRejectedSchema, fields: pathReason },
  diagnosticsArgs: { result: "diagnosticsResult", schema: DiagnosticsResultSchema, reject: "rejected", inner: DiagnosticsRejectedSchema, fields: pathReason },
  grepArgs: { result: "grepResult", schema: GrepResultSchema, reject: "error", inner: GrepErrorSchema, fields: (_a, error) => ({ error }) },
  shellArgs: { result: "shellResult", schema: ShellResultSchema, reject: "rejected", inner: ShellRejectedSchema, fields: shellReason },
  shellStreamArgs: { result: "shellStream", schema: ShellStreamSchema, oneof: "event", reject: "rejected", inner: ShellRejectedSchema, fields: shellReason },
  backgroundShellSpawnArgs: {
    result: "backgroundShellSpawnResult", schema: BackgroundShellSpawnResultSchema, reject: "error", inner: BackgroundShellSpawnErrorSchema,
    fields: (a, error) => ({ command: str(a.command), workingDirectory: str(a.workingDirectory), error }),
  },
  writeShellStdinArgs: { result: "writeShellStdinResult", schema: WriteShellStdinResultSchema, reject: "error", inner: WriteShellStdinErrorSchema, fields: (_a, error) => ({ error }) },
  fetchArgs: { result: "fetchResult", schema: FetchResultSchema, reject: "error", inner: FetchErrorSchema, fields: (a, error) => ({ url: str(a.url), error }) },
  recordScreenArgs: { result: "recordScreenResult", schema: RecordScreenResultSchema, reject: "failure", inner: RecordScreenFailureSchema, fields: (_a, error) => ({ error }) },
  computerUseArgs: {
    result: "computerUseResult", schema: ComputerUseResultSchema, reject: "error", inner: ComputerUseErrorSchema,
    fields: (a, error) => ({ error, actionCount: Array.isArray(a.actions) ? a.actions.length : 0, durationMs: 0 }),
  },
  listMcpResourcesExecArgs: { result: "listMcpResourcesExecResult", schema: ListMcpResourcesExecResultSchema, reject: "rejected", inner: ListMcpResourcesRejectedSchema, fields: (_a, reason) => ({ reason }) },
  readMcpResourceExecArgs: { result: "readMcpResourceExecResult", schema: ReadMcpResourceExecResultSchema, reject: "rejected", inner: ReadMcpResourceRejectedSchema, fields: (a, reason) => ({ uri: str(a.uri), reason }) },
};

/** Reject a Cursor-native tool exec, pointing the model at the Pi equivalent. */
function rejectNativeTool(h: ServerHandlers, execMsgId: number, execId: string, execCase: string, args: Args): void {
  const spec = NATIVE_REJECTS[execCase];
  if (!spec) {
    // Unknown exec case: throw so the server surfaces it instead of hanging.
    h.send(
      createClientMessage({
        message: {
          case: "execClientControlMessage",
          value: create(ExecClientControlMessageSchema, {
            message: {
              case: "throw",
              value: create(ExecClientThrowSchema, {
                id: execMsgId,
                error: `pi-cursor has no handler for Cursor exec case "${execCase}" (wire drift: agent.proto may be behind Cursor).`,
              }),
            },
          }),
        },
      }),
    );
    return;
  }
  const reason = nativeToolRejection(execCase, toolNames(h));
  const inner = create(spec.inner, spec.fields(args, reason) as never);
  const value = create(spec.schema, { [spec.oneof ?? "result"]: { case: spec.reject, value: inner } } as never);
  answerExec(h, execMsgId, execId, { case: spec.result, value });
}

function handleExec(h: ServerHandlers, exec: { id: number; execId: string; message: { case: string; value: unknown } }): void {
  const args = (exec.message.value ?? {}) as Record<string, unknown>;

  if (exec.message.case === "mcpArgs") {
    const mcp = args as { name?: string; toolName?: string; args?: Record<string, Uint8Array>; toolCallId?: string };
    const toolName = piToolName((mcp.toolName || mcp.name || "").trim());
    const known = toolNames(h);
    if (!toolName || !known.has(toolName)) {
      answerExec(h, exec.id, exec.execId, {
        case: "mcpResult",
        value: create(McpResultSchema, {
          result: {
            case: "toolNotFound",
            value: create(McpToolNotFoundSchema, { name: toolName, availableTools: [...known] }),
          },
        }),
      });
      return;
    }
    h.onToolCall({
      execMsgId: exec.id,
      execId: exec.execId,
      toolCallId: mcp.toolCallId || crypto.randomUUID(),
      toolName,
      arguments: decodeArgs(mcp.args ?? {}),
    });
    return;
  }

  if (exec.message.case === "requestContextArgs") {
    answerExec(h, exec.id, exec.execId, {
      case: "requestContextResult",
      value: create(RequestContextResultSchema, {
        result: {
          case: "success",
          value: create(RequestContextSuccessSchema, {
            requestContext: create(RequestContextSchema, {
              rules: [],
              repositoryInfo: [],
              tools: h.toolDefinitions,
              gitRepos: [],
              projectLayouts: [],
              mcpInstructions: [],
              fileContents: {},
              customSubagents: [],
            }),
          }),
        },
      }),
    });
    return;
  }

  rejectNativeTool(h, exec.id, exec.execId, exec.message.case, args);
}

function handleInteractionQuery(h: ServerHandlers, query: { id: number; query: { case: string; value: unknown } }): void {
  if (query.query.case === "askQuestionInteractionQuery") {
    // Pi has no mid-turn question UI (unlike cursor-agent's interactive prompt).
    // Tell the model to ask in text and keep going with its best judgment
    // instead of stalling on an answer that will never come.
    const unsupported =
      "Pi's Cursor provider has no interactive question UI. State the question in your reply text " +
      "and continue with your best judgment instead of waiting for an answer.";
    h.send(
      createClientMessage({
        message: {
          case: "interactionResponse",
          value: create(InteractionResponseSchema, {
            id: query.id,
            result: {
              case: "askQuestionInteractionResponse",
              value: create(AskQuestionInteractionResponseSchema, {
                result: create(AskQuestionResultSchema, {
                  result: { case: "error", value: create(AskQuestionErrorSchema, { errorMessage: unsupported }) },
                }),
              }),
            },
          }),
        },
      }),
    );
    return;
  }
  if (query.query.case === "webSearchRequestQuery") {
    // Route web search through Pi's own tools, like cursor-agent's search.
    const webTool = findWebTool(toolNames(h));
    const reason = webTool
      ? `Web search is not available natively in Pi. Call the MCP tool "${webTool}" with the same query instead.`
      : "Web search is not available in Pi (no web tool configured). Answer from your own knowledge and say so.";
    h.send(
      createClientMessage({
        message: {
          case: "interactionResponse",
          value: create(InteractionResponseSchema, {
            id: query.id,
            result: {
              case: "webSearchRequestResponse",
              value: create(WebSearchRequestResponseSchema, {
                result: {
                  case: "rejected",
                  value: create(WebSearchRequestResponse_RejectedSchema, { reason }),
                },
              }),
            },
          }),
        },
      }),
    );
    return;
  }
  h.onError(`Pi's Cursor provider does not support the ${query.query.case} interaction query.`);
}

/** Decode and dispatch one server frame. Undecodable frames are ignored. */
export function handleServerMessage(frame: Uint8Array, h: ServerHandlers): void {
  let server: ReturnType<typeof fromBinary<typeof AgentServerMessageSchema>>;
  try {
    server = fromBinary(AgentServerMessageSchema, frame);
  } catch {
    // Wire drift or a truncated frame; skip it rather than killing the turn.
    recordRun({ lastError: "undecodable AgentServerMessage frame" });
    h.onLiveness();
    return;
  }
  const message = server.message;
  if (!message) return;

  switch (message.case) {
    case "interactionUpdate": {
      const update = message.value.message;
      if (!update) return;
      switch (update.case) {
        case "textDelta": {
          const text = update.value.text;
          if (text) h.onText(text);
          else h.onLiveness();
          return;
        }
        case "thinkingDelta": {
          const text = update.value.text;
          if (text) h.onThinking(text);
          else h.onLiveness();
          return;
        }
        case "tokenDelta":
          h.onTokenDelta(update.value.tokens ?? 0);
          return;
        case "turnEnded":
          h.onTurnEnded();
          return;
        case "heartbeat":
          h.onLiveness();
          return;
        case "toolCallCompleted": {
          // Completion is informational. MCP results already arrived over the
          // exec channel and were applied as Pi tool results. Treating a later
          // non-success completion as onError aborted the whole turn with
          // "Cursor tool  failed: Tool execution error" after the tool had
          // already run (including successful bash/edit/read calls).
          h.onLiveness();
          return;
        }
        default:
          h.onLiveness();
          return;
      }
    }
    case "kvServerMessage":
      handleKv(h, message.value.id, message.value.message as { case: string; value: unknown });
      return;
    case "execServerMessage":
      handleExec(h, message.value as never);
      return;
    case "interactionQuery":
      handleInteractionQuery(h, message.value as never);
      return;
    case "execServerControlMessage": {
      const control = message.value.message;
      if (control?.case === "abort") h.onError("Cursor aborted the run.");
      return;
    }
    case "conversationCheckpointUpdate": {
      const details = message.value.tokenDetails;
      if (details && details.usedTokens > 0) h.onUsage(details.usedTokens);
      else h.onLiveness();
      return;
    }
    default:
      h.onLiveness();
      return;
  }
}


