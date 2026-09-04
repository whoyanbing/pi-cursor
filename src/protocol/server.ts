/**
 * Handles `AgentServerMessage` frames arriving on the Run stream.
 *
 * The server drives the turn from here: it streams text/thinking deltas, pulls
 * blobs it was given ids for (KV channel), asks the client to execute MCP tools
 * or rejects Cursor-native tools (exec channel), and occasionally asks an
 * interaction question. Each case either produces output for Pi or writes an
 * answer frame back on the same stream.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
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
import { decodeArgs } from "./request.js";
import type { BlobStore } from "./blobs.js";
import { nativeToolRejection } from "./tools.js";

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

/** Reject a Cursor-native tool exec, pointing the model at the Pi equivalent. */
function rejectNativeTool(
  h: ServerHandlers,
  execMsgId: number,
  execId: string,
  execCase: string,
  args: Record<string, unknown>,
): void {
  const reason = nativeToolRejection(execCase, toolNames(h));
  const path = String(args.path ?? "");
  const command = String(args.command ?? "");
  const workingDirectory = String(args.workingDirectory ?? "");
  const url = String(args.url ?? "");
  const uri = String(args.uri ?? "");

  switch (execCase) {
    case "readArgs":
      return answerExec(h, execMsgId, execId, {
        case: "readResult",
        value: create(ReadResultSchema, {
          result: { case: "rejected", value: create(ReadRejectedSchema, { path, reason }) },
        }),
      });
    case "lsArgs":
      return answerExec(h, execMsgId, execId, {
        case: "lsResult",
        value: create(LsResultSchema, {
          result: { case: "rejected", value: create(LsRejectedSchema, { path, reason }) },
        }),
      });
    case "grepArgs":
      return answerExec(h, execMsgId, execId, {
        case: "grepResult",
        value: create(GrepResultSchema, { result: { case: "error", value: create(GrepErrorSchema, { error: reason }) } }),
      });
    case "writeArgs":
      return answerExec(h, execMsgId, execId, {
        case: "writeResult",
        value: create(WriteResultSchema, {
          result: { case: "rejected", value: create(WriteRejectedSchema, { path, reason }) },
        }),
      });
    case "deleteArgs":
      return answerExec(h, execMsgId, execId, {
        case: "deleteResult",
        value: create(DeleteResultSchema, {
          result: { case: "rejected", value: create(DeleteRejectedSchema, { path, reason }) },
        }),
      });
    case "shellArgs":
      return answerExec(h, execMsgId, execId, {
        case: "shellResult",
        value: create(ShellResultSchema, {
          result: {
            case: "rejected",
            value: create(ShellRejectedSchema, { command, workingDirectory, reason, isReadonly: false }),
          },
        }),
      });
    case "shellStreamArgs":
      return answerExec(h, execMsgId, execId, {
        case: "shellStream",
        value: create(ShellStreamSchema, {
          event: {
            case: "rejected",
            value: create(ShellRejectedSchema, { command, workingDirectory, reason, isReadonly: false }),
          },
        }),
      });
    case "backgroundShellSpawnArgs":
      return answerExec(h, execMsgId, execId, {
        case: "backgroundShellSpawnResult",
        value: create(BackgroundShellSpawnResultSchema, {
          result: {
            case: "error",
            value: create(BackgroundShellSpawnErrorSchema, { command, workingDirectory, error: reason }),
          },
        }),
      });
    case "writeShellStdinArgs":
      return answerExec(h, execMsgId, execId, {
        case: "writeShellStdinResult",
        value: create(WriteShellStdinResultSchema, {
          result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: reason }) },
        }),
      });
    case "fetchArgs":
      return answerExec(h, execMsgId, execId, {
        case: "fetchResult",
        value: create(FetchResultSchema, { result: { case: "error", value: create(FetchErrorSchema, { url, error: reason }) } }),
      });
    case "diagnosticsArgs":
      return answerExec(h, execMsgId, execId, {
        case: "diagnosticsResult",
        value: create(DiagnosticsResultSchema, {
          result: { case: "rejected", value: create(DiagnosticsRejectedSchema, { path, reason }) },
        }),
      });
    case "recordScreenArgs":
      return answerExec(h, execMsgId, execId, {
        case: "recordScreenResult",
        value: create(RecordScreenResultSchema, {
          result: { case: "failure", value: create(RecordScreenFailureSchema, { error: reason }) },
        }),
      });
    case "computerUseArgs":
      return answerExec(h, execMsgId, execId, {
        case: "computerUseResult",
        value: create(ComputerUseResultSchema, {
          result: {
            case: "error",
            value: create(ComputerUseErrorSchema, {
              error: reason,
              actionCount: Array.isArray(args.actions) ? args.actions.length : 0,
              durationMs: 0,
            }),
          },
        }),
      });
    case "listMcpResourcesExecArgs":
      return answerExec(h, execMsgId, execId, {
        case: "listMcpResourcesExecResult",
        value: create(ListMcpResourcesExecResultSchema, {
          result: { case: "rejected", value: create(ListMcpResourcesRejectedSchema, { reason }) },
        }),
      });
    case "readMcpResourceExecArgs":
      return answerExec(h, execMsgId, execId, {
        case: "readMcpResourceExecResult",
        value: create(ReadMcpResourceExecResultSchema, {
          result: { case: "rejected", value: create(ReadMcpResourceRejectedSchema, { uri, reason }) },
        }),
      });
    default:
      // Unknown exec case: throw so the server surfaces it instead of hanging.
      return h.send(
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
  }
}

function handleExec(h: ServerHandlers, exec: { id: number; execId: string; message: { case: string; value: unknown } }): void {
  const args = (exec.message.value ?? {}) as Record<string, unknown>;

  if (exec.message.case === "mcpArgs") {
    const mcp = args as { name?: string; toolName?: string; args?: Record<string, Uint8Array>; toolCallId?: string };
    const toolName = mcp.toolName || mcp.name || "";
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
  const unsupported = `Pi's Cursor provider does not support the ${query.query.case} interaction query.`;
  if (query.query.case === "askQuestionInteractionQuery") {
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
                  value: create(WebSearchRequestResponse_RejectedSchema, { reason: unsupported }),
                },
              }),
            },
          }),
        },
      }),
    );
    return;
  }
  h.onError(unsupported);
}

/** Decode and dispatch one server frame. Undecodable frames are ignored. */
export function handleServerMessage(frame: Uint8Array, h: ServerHandlers): void {
  let server: ReturnType<typeof fromBinary<typeof AgentServerMessageSchema>>;
  try {
    server = fromBinary(AgentServerMessageSchema, frame);
  } catch {
    // Wire drift or a truncated frame; skip it rather than killing the turn.
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
          // Native tool errors are surfaced so the model can adapt; MCP results
          // flow through the exec channel instead.
          const result = update.value.toolCall?.tool;
          if (result?.case === "mcpToolCall") {
            const mcpResult = result.value.result?.result;
            if (mcpResult && mcpResult.case !== "success") {
              const error = (mcpResult.value as { error?: string; reason?: string }).error ??
                (mcpResult.value as { reason?: string }).reason;
              if (error) h.onError(`Cursor tool ${result.value.args?.toolName ?? ""} failed: ${error}`);
            }
          }
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
      if (details) h.onUsage(details.usedTokens ?? 0);
      else h.onLiveness();
      return;
    }
    default:
      h.onLiveness();
      return;
  }
}


