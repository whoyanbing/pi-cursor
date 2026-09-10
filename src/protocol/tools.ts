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
  readArgs: ["read"],
  lsArgs: ["ls"],
  grepArgs: ["grep"],
  writeArgs: ["write", "edit"],
  deleteArgs: ["bash", "edit"],
  shellArgs: ["bash", "shell", "exec"],
  shellStreamArgs: ["bash", "shell", "exec"],
  backgroundShellSpawnArgs: ["bash", "shell", "exec"],
  writeShellStdinArgs: ["bash", "shell", "exec"],
  fetchArgs: ["web_search", "webfetch", "fetch", "tavily_search"],
};

/**
 * Web-capable MCP tools, for the web-search interaction fallback. Generic
 * names like `search` are deliberately excluded: they usually mean code search.
 */
const WEB_TOOL_CANDIDATES = ["web_search", "webfetch", "fetch", "tavily_search"];

/** Case-insensitive lookup that returns Pi's actual tool name (casing intact). */
export function findPiTool(
  candidates: readonly string[],
  availableTools: ReadonlySet<string>,
): string | undefined {
  const byLower = new Map<string, string>();
  for (const name of availableTools) {
    const key = name.toLowerCase();
    if (!byLower.has(key)) byLower.set(key, name);
  }
  for (const candidate of candidates) {
    const match = byLower.get(candidate.toLowerCase());
    if (match) return match;
  }
  return undefined;
}

export function findWebTool(availableTools: ReadonlySet<string>): string | undefined {
  return findPiTool(WEB_TOOL_CANDIDATES, availableTools);
}

export function nativeToolRejection(
  execCase: string,
  availableTools: ReadonlySet<string>,
): string {
  const candidates = NATIVE_TOOL_EQUIVALENTS[execCase] ?? [];
  const match = findPiTool(candidates, availableTools);
  if (match) {
    return `This native Cursor tool is not available in Pi. Call the MCP tool "${match}" with the same arguments instead.`;
  }
  return "This native Cursor tool is not available in Pi. Use the MCP tools provided instead.";
}
