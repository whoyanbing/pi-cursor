import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ExecClientMessageSchema,
  McpErrorSchema,
  McpImageContentSchema,
  McpResultSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
} from "../proto/agent_pb.js";
import type { ToolResultPayload } from "./context.js";

/** Exec answers carry `McpResult` (error case = `McpError`). */
export function buildMcpResult(payload: ToolResultPayload) {
  if (payload.isError) {
    return create(McpResultSchema, {
      result: { case: "error", value: create(McpErrorSchema, { error: payload.content }) },
    });
  }
  const content = [];
  if (payload.content) {
    content.push(
      create(McpToolResultContentItemSchema, {
        content: { case: "text" as const, value: create(McpTextContentSchema, { text: payload.content }) },
      }),
    );
  }
  for (const image of payload.images ?? []) {
    content.push(
      create(McpToolResultContentItemSchema, {
        content: { case: "image" as const, value: create(McpImageContentSchema, { data: image.data, mimeType: image.mimeType }) },
      }),
    );
  }
  if (!content.length) {
    content.push(
      create(McpToolResultContentItemSchema, {
        content: { case: "text" as const, value: create(McpTextContentSchema, { text: "" }) },
      }),
    );
  }
  return create(McpResultSchema, {
    result: { case: "success", value: create(McpSuccessSchema, { content, isError: false }) },
  });
}

export function encodeExecResult(execMsgId: number, execId: string, payload: ToolResultPayload): Uint8Array {
  return toBinary(
    AgentClientMessageSchema,
    create(AgentClientMessageSchema, {
      message: {
        case: "execClientMessage",
        value: create(ExecClientMessageSchema, {
          id: execMsgId,
          execId,
          message: { case: "mcpResult", value: buildMcpResult(payload) },
        }),
      },
    }),
  );
}
