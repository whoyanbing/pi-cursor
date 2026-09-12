/**
 * Bounds for tool results sent to Cursor — live MCP exec answers and
 * replayed history both go through this so a huge bash/read dump cannot
 * blow the HTTP/2 stream or the next rebuild.
 */
import { create } from "@bufbuild/protobuf";
import {
  McpImageContentSchema,
  McpSuccessSchema,
  McpTextContentSchema,
  McpToolResultContentItemSchema,
  type McpSuccess,
} from "../proto/agent_pb.js";
import type { ToolResultPayload } from "./context.js";

export const MAX_TOOL_RESULT_TEXT_BYTES = 512 * 1024;
export const MAX_TOOL_RESULT_TOTAL_BYTES = 16 * 1024 * 1024;

export function truncateUtf8(text: string, maxBytes: number, originalBytes: number): string {
  const suffix = `\n\n[pi-cursor truncated this tool result from ${originalBytes} bytes to protect the agent context. Use a narrower command, path, or line range.]`;
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const bytes = Buffer.from(text, "utf8");
  let end = Math.max(0, maxBytes - suffixBytes);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8") + suffix;
}

export function boundToolResultText(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  return bytes > MAX_TOOL_RESULT_TEXT_BYTES ? truncateUtf8(content, MAX_TOOL_RESULT_TEXT_BYTES, bytes) : content;
}

/** Bounded payload → `McpSuccess` (text + images, or one empty text item). */
export function mcpSuccess(payload: ToolResultPayload): McpSuccess {
  const bounded = boundToolResultPayload(payload);
  const content = [];
  if (bounded.content) {
    content.push(create(McpToolResultContentItemSchema, {
      content: { case: "text" as const, value: create(McpTextContentSchema, { text: bounded.content }) },
    }));
  }
  for (const image of bounded.images) {
    content.push(create(McpToolResultContentItemSchema, {
      content: { case: "image" as const, value: create(McpImageContentSchema, { data: image.data, mimeType: image.mimeType }) },
    }));
  }
  if (content.length === 0) {
    content.push(create(McpToolResultContentItemSchema, {
      content: { case: "text" as const, value: create(McpTextContentSchema, { text: "" }) },
    }));
  }
  return create(McpSuccessSchema, { content, isError: false });
}

/** Truncate text and drop trailing images that would exceed the total cap. */
export function boundToolResultPayload(payload: ToolResultPayload): ToolResultPayload {
  const content = boundToolResultText(payload.content);
  const images = [];
  let usedBytes = Buffer.byteLength(content, "utf8");
  let droppedImages = 0;
  for (const image of payload.images ?? []) {
    const imageBytes = image.data.byteLength + Buffer.byteLength(image.mimeType, "utf8");
    if (usedBytes + imageBytes > MAX_TOOL_RESULT_TOTAL_BYTES) {
      droppedImages += 1;
      continue;
    }
    images.push(image);
    usedBytes += imageBytes;
  }
  if (droppedImages === 0) return { ...payload, content, images };
  const notice = `[pi-cursor omitted ${droppedImages} oversized tool image(s) to protect the transport.]`;
  return {
    ...payload,
    content: content ? `${content}\n\n${notice}` : notice,
    images,
  };
}
