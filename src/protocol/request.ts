/**
 * Builds the `AgentRunRequest` that starts (or continues) a Cursor turn.
 *
 * Everything large is content-addressed into the blob store and referenced by
 * SHA-256 id: the system prompt, each rendered history message, each turn
 * structure, and each conversation step. The server pulls what it needs back
 * over the KV channel while the stream runs.
 */
import { create, fromBinary, fromJson, toBinary, toJson, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  AgentClientMessageSchema,
  AgentConversationTurnStructureSchema,
  AgentRunRequestSchema,
  AssistantMessageSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ConversationStepSchema,
  ConversationTurnStructureSchema,
  McpArgsSchema,
  McpImageContentSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolCallSchema,
  McpToolErrorSchema,
  McpToolResultContentItemSchema,
  McpToolResultSchema,
  McpToolsSchema,
  RequestedModelSchema,
  RequestedModel_ModelParameterbytesSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  ThinkingMessageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  type McpToolDefinition,
  type McpToolResult,
} from "../proto/agent_pb.js";
import type { ImagePart, ParsedTurn, TurnStep } from "./context.js";
import { BlobStore } from "./blobs.js";
import { buildHistory, encodeMessage, mcpToolName, MCP_PROVIDER } from "./prompt.js";
import { boundToolResultPayload } from "./tool-result.js";

export { MAX_TOOL_RESULT_TEXT_BYTES, MAX_TOOL_RESULT_TOTAL_BYTES, boundToolResultText } from "./tool-result.js";

export interface ModelRouting {
  /** Raw Cursor model id to request (may carry an effort suffix). */
  modelId: string;
  maxMode?: boolean;
  parameters?: Array<{ id: string; value: string }>;
}

export interface BuildRequestInput {
  systemPrompt: string;
  completedTurns: readonly ParsedTurn[];
  actionText: string;
  actionImages?: readonly ImagePart[];
  toolDefinitions: McpToolDefinition[];
  routing: ModelRouting;
  conversationId: string;
  /** Reuse a blob store across a bridge pause so KV answers keep working. */
  blobs?: BlobStore;
  /** Workspace directory for Cursor's previousWorkspaceUris (Pi session cwd). */
  workspaceCwd?: string;
}

export interface BuiltRequest {
  bytes: Uint8Array;
  blobs: BlobStore;
}

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

/**
 * `SelectedContextBlob` has no generated schema; emit the raw wire format for
 * the two fields Cursor reads: field 1 (repeated bytes) root-prompt blob refs
 * and field 22 (string) client name.
 */
export function buildSelectedContextBlob(rootPromptBlobIds: readonly Uint8Array[], clientName: string): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const blobId of rootPromptBlobIds) {
    parts.push(new Uint8Array([0x0a, ...encodeVarint(blobId.length), ...blobId]));
  }
  const nameBytes = new TextEncoder().encode(clientName);
  parts.push(new Uint8Array([0xb2, 0x01, ...encodeVarint(nameBytes.length), ...nameBytes]));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** MCP arg values travel as protobuf `Value` bytes; fall back to UTF-8 text. */
export function encodeArgValue(value: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, value as JsonValue));
  } catch {
    return new TextEncoder().encode(String(value));
  }
}

export function encodeArgs(args: Record<string, unknown>): Record<string, Uint8Array> {
  const encoded: Record<string, Uint8Array> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    encoded[key] = encodeArgValue(value);
  }
  return encoded;
}

/** Decode a protobuf `Value` (or raw UTF-8 text) back into a JS value. */
export function decodeArgValue(bytes: Uint8Array): unknown {
  try {
    return toJson(ValueSchema, fromBinary(ValueSchema, bytes));
  } catch {
    // Not a protobuf Value; treat the bytes as UTF-8 text.
    return new TextDecoder().decode(bytes);
  }
}

export function decodeArgs(args: Record<string, Uint8Array>): Record<string, unknown> {
  const decoded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    decoded[key] = decodeArgValue(value);
  }
  return decoded;
}

function stepBytes(step: TurnStep): Uint8Array {
  if (step.kind === "text") {
    return toBinary(
      ConversationStepSchema,
      create(ConversationStepSchema, {
        message: { case: "assistantMessage", value: create(AssistantMessageSchema, { text: step.text }) },
      }),
    );
  }
  if (step.kind === "thinking") {
    return toBinary(
      ConversationStepSchema,
      create(ConversationStepSchema, {
        message: { case: "thinkingMessage", value: create(ThinkingMessageSchema, { text: step.text }) },
      }),
    );
  }

  const toolName = step.toolName || "tool";
  let resultMessage: McpToolResult | undefined;
  if (step.result) {
    const bounded = boundToolResultPayload(step.result);
    if (bounded.isError) {
      resultMessage = create(McpToolResultSchema, {
        result: { case: "error", value: create(McpToolErrorSchema, { error: bounded.content }) },
      });
    } else {
      const items = [];
      if (bounded.content.length > 0) {
        items.push(
          create(McpToolResultContentItemSchema, {
            content: { case: "text" as const, value: create(McpTextContentSchema, { text: bounded.content }) },
          }),
        );
      }
      for (const image of bounded.images) {
        items.push(
          create(McpToolResultContentItemSchema, {
            content: {
              case: "image" as const,
              value: create(McpImageContentSchema, { data: image.data, mimeType: image.mimeType }),
            },
          }),
        );
      }
      if (items.length === 0) {
        items.push(
          create(McpToolResultContentItemSchema, {
            content: { case: "text" as const, value: create(McpTextContentSchema, { text: "" }) },
          }),
        );
      }
      resultMessage = create(McpToolResultSchema, {
        result: { case: "success", value: create(McpSuccessSchema, { content: items, isError: false }) },
      });
    }
  }

  return toBinary(
    ConversationStepSchema,
    create(ConversationStepSchema, {
      message: {
        case: "toolCall",
        value: create(ToolCallSchema, {
          tool: {
            case: "mcpToolCall",
            value: create(McpToolCallSchema, {
              args: create(McpArgsSchema, {
                name: toolName,
                args: encodeArgs(step.arguments),
                toolCallId: step.toolCallId,
                providerIdentifier: MCP_PROVIDER,
                toolName,
              }),
              ...(resultMessage ? { result: resultMessage } : {}),
            }),
          },
        }),
      },
    }),
  );
}

function userMessageBlob(turn: ParsedTurn, selectedContextBlob: Uint8Array, blobs: BlobStore): Uint8Array {
  const message = create(UserMessageSchema, {
    text: turn.userText,
    messageId: randomUUID(),
    selectedContext: create(SelectedContextSchema, {
      selectedImages: turn.userImages.map((image) =>
        create(SelectedImageSchema, {
          uuid: randomUUID(),
          mimeType: image.mimeType,
          dataOrBlobId: { case: "data" as const, value: image.data },
        }),
      ),
    }),
    mode: 1,
    selectedContextBlob,
    correlationId: randomUUID(),
  });
  return blobs.put(toBinary(UserMessageSchema, message));
}

export function buildRunRequest(input: BuildRequestInput): BuiltRequest {
  const blobs = input.blobs ?? new BlobStore();

  const systemBytes = new TextEncoder().encode(
    JSON.stringify({ role: "system", content: input.systemPrompt }),
  );
  const systemBlobId = blobs.put(systemBytes);
  const selectedContextBlob = blobs.put(buildSelectedContextBlob([systemBlobId], MCP_PROVIDER));

  // The prompt the model actually reads: system prompt + every completed turn,
  // each rendered as one AI-SDK-shaped JSON message and stored as a blob.
  const historyBlobIds = buildHistory(input.systemPrompt, input.completedTurns).map((message) =>
    blobs.put(encodeMessage(message)),
  );

  const turnBlobIds = input.completedTurns.map((turn) => {
    const userBlobId = userMessageBlob(turn, selectedContextBlob, blobs);
    const stepBlobIds = turn.steps.map((step) => blobs.put(stepBytes(step)));
    const structure = create(ConversationTurnStructureSchema, {
      turn: {
        case: "agentConversationTurn" as const,
        value: create(AgentConversationTurnStructureSchema, {
          userMessage: userBlobId,
          steps: stepBlobIds,
          requestId: randomUUID(),
        }),
      },
    });
    return blobs.put(toBinary(ConversationTurnStructureSchema, structure));
  });

  const conversationState = create(ConversationStateStructureSchema, {
    rootPromptMessagesJson: [systemBlobId, ...historyBlobIds],
    turns: turnBlobIds,
    todos: [],
    pendingToolCalls: [],
    previousWorkspaceUris: [pathToFileURL(input.workspaceCwd?.trim() || process.cwd()).href],
    mode: 1,
    fileStates: {},
    fileStatesV2: {},
    summaryArchives: [],
    turnTimings: [],
    subagentStates: {},
    selfSummaryCount: 0,
    readPaths: [],
    clientName: MCP_PROVIDER,
  });

  const actionMessage = create(UserMessageSchema, {
    text: input.actionText,
    messageId: randomUUID(),
    selectedContext: create(SelectedContextSchema, {
      selectedImages: (input.actionImages ?? []).map((image) =>
        create(SelectedImageSchema, {
          uuid: randomUUID(),
          mimeType: image.mimeType,
          dataOrBlobId: { case: "data" as const, value: image.data },
        }),
      ),
    }),
    mode: 1,
    selectedContextBlob,
    correlationId: randomUUID(),
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationState,
    action: create(ConversationActionSchema, {
      action: { case: "userMessageAction" as const, value: create(UserMessageActionSchema, { userMessage: actionMessage }) },
    }),
    requestedModel: create(RequestedModelSchema, {
      modelId: input.routing.modelId,
      maxMode: input.routing.maxMode ?? false,
      parameters: (input.routing.parameters ?? []).map((parameter) =>
        create(RequestedModel_ModelParameterbytesSchema, parameter),
      ),
    }),
    conversationId: input.conversationId,
    mcpTools: create(McpToolsSchema, { mcpTools: input.toolDefinitions }),
  });

  const bytes = toBinary(
    AgentClientMessageSchema,
    create(AgentClientMessageSchema, { message: { case: "runRequest" as const, value: runRequest } }),
  );
  return { bytes, blobs };
}
