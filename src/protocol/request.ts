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
  McpToolCallSchema,
  McpToolErrorSchema,
  McpToolResultSchema,
  McpToolsSchema,
  RequestedModelSchema,
  RequestedModel_ModelParameterbytesSchema,
  SelectedContextBlobSchema,
  SelectedContextSchema,
  SelectedImageSchema,
  ThinkingMessageSchema,
  ToolCallSchema,
  UserMessageActionSchema,
  UserMessageSchema,
  type McpToolDefinition,
  type McpToolResult,
  type UserMessage,
} from "../proto/agent_pb.js";
import type { ImagePart, ParsedTurn, TurnStep } from "./context.js";
import { BlobStore } from "./blobs.js";
import { buildHistory, encodeMessage, MCP_PROVIDER } from "./prompt.js";
import { boundToolResultText, mcpSuccess } from "./tool-result.js";

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

export function buildSelectedContextBlob(rootPromptBlobIds: readonly Uint8Array[], clientName: string): Uint8Array {
  return toBinary(
    SelectedContextBlobSchema,
    create(SelectedContextBlobSchema, { rootPromptBlobIds: [...rootPromptBlobIds], clientName }),
  );
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
    resultMessage = step.result.isError
      ? create(McpToolResultSchema, {
          result: { case: "error", value: create(McpToolErrorSchema, { error: boundToolResultText(step.result.content) }) },
        })
      : create(McpToolResultSchema, { result: { case: "success", value: mcpSuccess(step.result) } });
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

function userMessage(text: string, images: readonly ImagePart[], selectedContextBlob: Uint8Array): UserMessage {
  return create(UserMessageSchema, {
    text,
    messageId: randomUUID(),
    selectedContext: create(SelectedContextSchema, {
      selectedImages: images.map((image) =>
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
    const userBlobId = blobs.put(toBinary(UserMessageSchema, userMessage(turn.userText, turn.userImages, selectedContextBlob)));
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

  const actionMessage = userMessage(input.actionText, input.actionImages ?? [], selectedContextBlob);

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
