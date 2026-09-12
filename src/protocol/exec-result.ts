import { create } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ExecClientMessageSchema,
  McpErrorSchema,
  McpResultSchema,
  type AgentClientMessage,
} from "../proto/agent_pb.js";
import type { ToolResultPayload } from "./context.js";
import { boundToolResultText, mcpSuccess } from "./tool-result.js";

/** Exec answers carry `McpResult` (error case = `McpError`). */
export function buildMcpResult(payload: ToolResultPayload) {
  if (payload.isError) {
    return create(McpResultSchema, {
      result: { case: "error", value: create(McpErrorSchema, { error: boundToolResultText(payload.content) }) },
    });
  }
  return create(McpResultSchema, { result: { case: "success", value: mcpSuccess(payload) } });
}

export function buildExecResult(execMsgId: number, execId: string, payload: ToolResultPayload): AgentClientMessage {
  return create(AgentClientMessageSchema, {
    message: {
      case: "execClientMessage",
      value: create(ExecClientMessageSchema, {
        id: execMsgId,
        execId,
        message: { case: "mcpResult", value: buildMcpResult(payload) },
      }),
    },
  });
}
