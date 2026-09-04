/**
 * Pi tools → Cursor MCP tool definitions, plus the reject advice for Cursor's
 * native tool execs (which Pi does not run — Pi's own tools do the same job).
 */
import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { Tool } from "@earendil-works/pi-ai";
import { McpToolDefinitionSchema, type McpToolDefinition } from "../proto/agent_pb.js";
import { MCP_PROVIDER, mcpToolName } from "./prompt.js";

/** Encode a JSON Schema as the protobuf `Value` Cursor expects for inputSchema. */
export function encodeInputSchema(schema: unknown): Uint8Array {
  try {
    return toBinary(ValueSchema, fromJson(ValueSchema, (schema ?? { type: "object" }) as JsonValue));
  } catch {
    return toBinary(ValueSchema, fromJson(ValueSchema, { type: "object" }));
  }
}

export function buildToolDefinitions(tools: readonly Tool[] | undefined): McpToolDefinition[] {
  const definitions: McpToolDefinition[] = [];
  for (const tool of tools ?? []) {
    if (!tool?.name) continue;
    definitions.push(
      create(McpToolDefinitionSchema, {
        name: mcpToolName(tool.name),
        providerIdentifier: MCP_PROVIDER,
        toolName: tool.name,
        description: tool.description ?? "",
        inputSchema: encodeInputSchema(tool.parameters),
      }),
    );
  }
  return definitions;
}

/**
 * Cursor native tools map onto Pi tools with the same job. When the model asks
 * Cursor to run one natively, reject it and name the Pi tool to call instead so
 * the next step goes through MCP and actually executes.
 */
const NATIVE_TOOL_EQUIVALENTS: Record<string, string[]> = {
  readArgs: ["read", "Read"],
  lsArgs: ["ls", "LS"],
  grepArgs: ["grep", "Grep"],
  writeArgs: ["write", "edit", "Edit"],
  deleteArgs: ["bash", "edit", "Edit"],
  shellArgs: ["bash"],
  shellStreamArgs: ["bash"],
  backgroundShellSpawnArgs: ["bash"],
  writeShellStdinArgs: ["bash"],
  fetchArgs: ["web_search", "fetch"],
};

export function nativeToolRejection(
  execCase: string,
  availableTools: ReadonlySet<string>,
): string {
  const candidates = NATIVE_TOOL_EQUIVALENTS[execCase] ?? [];
  const match = candidates.find((name) => availableTools.has(name));
  if (match) {
    return `This native Cursor tool is not available in Pi. Call the MCP tool "${match}" with the same arguments instead.`;
  }
  return "This native Cursor tool is not available in Pi. Use the MCP tools provided instead.";
}
