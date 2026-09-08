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
import { boundToolResultPayload } from "./tool-result.js";

/** Exec answers carry `McpResult` (error case = `McpError`). */
export function buildMcpResult(payload: ToolResultPayload) {
  const bounded = boundToolResultPayload(payload);
  if (bounded.isError) {
    return create(McpResultSchema, {
      result: { case: "error", value: create(McpErrorSchema, { error: bounded.content }) },
    });
  }
  const content = [];
  if (bounded.content) {
    content.push(
      create(McpToolResultContentItemSchema, {
        content: { case: "text" as const, value: create(McpTextContentSchema, { text: bounded.content }) },
      }),
    );
  }
  for (const image of bounded.images ?? []) {
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
