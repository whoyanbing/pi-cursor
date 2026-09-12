import { describe, expect, it } from "vitest";


import { buildExecResult } from "../protocol/exec-result.js";
import {
  boundToolResultPayload,
  boundToolResultText,
  MAX_TOOL_RESULT_TEXT_BYTES,
} from "../protocol/tool-result.js";

describe("boundToolResultText", () => {
  it("leaves small payloads alone", () => {
    expect(boundToolResultText("ok")).toBe("ok");
  });

  it("truncates oversized utf-8 text and keeps a notice", () => {
    const huge = "x".repeat(MAX_TOOL_RESULT_TEXT_BYTES + 50);
    const bounded = boundToolResultText(huge);
    expect(Buffer.byteLength(bounded, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES);
    expect(bounded).toContain("truncated this tool result");
  });
});

describe("boundToolResultPayload", () => {
  it("drops images that would exceed the total cap", () => {
    const payload = boundToolResultPayload({
      content: "text",
      isError: false,
      images: [{ data: new Uint8Array(20 * 1024 * 1024), mimeType: "image/png" }],
    });
    expect(payload.images).toEqual([]);
    expect(payload.content).toContain("omitted 1 oversized tool image");
  });
});

describe("buildExecResult", () => {
  it("truncates live MCP success text", () => {
    const huge = "y".repeat(MAX_TOOL_RESULT_TEXT_BYTES + 80);
    const message = buildExecResult(1, "exec-1", { content: huge, images: [], isError: false });
    expect(message.message.case).toBe("execClientMessage");
    if (message.message.case !== "execClientMessage") throw new Error("expected execClientMessage");
    const result = message.message.value.message;
    expect(result.case).toBe("mcpResult");
    if (result.case !== "mcpResult") throw new Error("expected mcpResult");
    expect(result.value.result.case).toBe("success");
    if (result.value.result.case !== "success") throw new Error("expected success");
    const text = result.value.result.value.content.find((item) => item.content.case === "text");
    expect(text?.content.case).toBe("text");
    if (text?.content.case !== "text") throw new Error("expected text");
    expect(text.content.value.text).toContain("truncated this tool result");
    expect(Buffer.byteLength(text.content.value.text, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES);
  });
});
