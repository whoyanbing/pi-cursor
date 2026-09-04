/**
 * Builds the model-facing prompt history Cursor actually renders.
 *
 * The server assembles the model prompt from `root_prompt_messages_json` — a
 * list of blob ids, each holding one JSON message in the AI-SDK "model message"
 * shape. The `turns` field is conversation *state* (UI/checkpointing) and is
 * never rendered back into the prompt, so history that only lives in `turns`
 * reaches the model as a single fresh question.
 *
 * Two shapes matter:
 *   - `{"role":"system"}` entries are dropped server-side; Pi's system prompt
 *     rides a *user* message framed in `<rules>`, the way Cursor frames its own.
 *   - Tool calls/results replay as `tool-call` / `tool-result` content parts
 *     with Cursor's `mcp_<provider>_<tool>` names.
 */
import type { ParsedTurn, TurnStep } from "./context.js";

export const MCP_PROVIDER = "pi";
/** Bound replayed tool results so long history cannot blow the prompt. */
export const MAX_REPLAYED_RESULT_CHARS = 20_000;

export interface TextPart {
  type: "text";
  text: string;
}
export interface ToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}
export interface ToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: string;
  isError?: boolean;
}

export type RootPromptMessage =
  | { role: "user"; content: TextPart[] }
  | { role: "assistant"; content: Array<TextPart | ToolCallPart> }
  | { role: "tool"; content: ToolResultPart[] };

/** Cursor namespaces MCP tools as `mcp_<providerIdentifier>_<toolName>`. */
export function mcpToolName(toolName: string): string {
  const name = toolName.trim();
  if (!name) return `mcp_${MCP_PROVIDER}_tool`;
  if (name.startsWith(`mcp_${MCP_PROVIDER}_`)) return name;
  return `mcp_${MCP_PROVIDER}_${name}`;
}

/** Strip the `mcp_pi_` namespace to recover Pi's tool name. */
export function piToolName(namespaced: string): string {
  const prefix = `mcp_${MCP_PROVIDER}_`;
  return namespaced.startsWith(prefix) ? namespaced.slice(prefix.length) : namespaced;
}

function truncateResult(text: string): string {
  if (text.length <= MAX_REPLAYED_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_REPLAYED_RESULT_CHARS)}\n\n[pi-cursor truncated this replayed tool result.]`;
}

/** Pi's system prompt, framed the way Cursor frames its own instructions. */
export function systemPromptMessage(systemPrompt: string): RootPromptMessage {
  return { role: "user", content: [{ type: "text", text: `<rules>\n${systemPrompt}\n</rules>` }] };
}

function isToolCall(step: TurnStep): step is Extract<TurnStep, { kind: "toolCall" }> {
  return step.kind === "toolCall";
}

/** Render one completed turn as the user/assistant/tool messages Cursor renders. */
export function turnMessages(turn: ParsedTurn): RootPromptMessage[] {
  const messages: RootPromptMessage[] = [];
  const userText = turn.userText.trim();
  const imageNote = turn.userImages.length
    ? `\n\n[${turn.userImages.length} image attachment(s) from this earlier turn are not replayed.]`
    : "";
  if (userText || imageNote) {
    messages.push({
      role: "user",
      content: [{ type: "text", text: `<user_query>\n${userText}${imageNote}\n</user_query>` }],
    });
  }

  const assistantContent: Array<TextPart | ToolCallPart> = [];
  const pendingResults: ToolResultPart[] = [];
  const flush = (): void => {
    if (assistantContent.length > 0) {
      messages.push({ role: "assistant", content: [...assistantContent] });
      assistantContent.length = 0;
    }
    if (pendingResults.length > 0) {
      messages.push({ role: "tool", content: [...pendingResults] });
      pendingResults.length = 0;
    }
  };

  for (const step of turn.steps) {
    // Reasoning is not replayed: it is re-derived and not portable across turns.
    if (step.kind === "thinking") continue;
    if (step.kind === "text") {
      if (!step.text) continue;
      // New assistant text after tool results starts a fresh message pair.
      if (pendingResults.length > 0) flush();
      assistantContent.push({ type: "text", text: step.text });
      continue;
    }
    if (!isToolCall(step)) continue;
    const toolName = mcpToolName(step.toolName);
    assistantContent.push({
      type: "tool-call",
      toolCallId: step.toolCallId,
      toolName,
      args: step.arguments,
    });
    if (step.result) {
      const imageSuffix = step.result.images.length
        ? `\n\n[${step.result.images.length} image(s) in this earlier tool result are not replayed.]`
        : "";
      pendingResults.push({
        type: "tool-result",
        toolCallId: step.toolCallId,
        toolName,
        result: truncateResult(`${step.result.content}${imageSuffix}`),
        ...(step.result.isError ? { isError: true } : {}),
      });
    }
  }
  flush();

  return messages;
}

/** Full prompt history: Pi's system prompt followed by every completed turn. */
export function buildHistory(systemPrompt: string, turns: readonly ParsedTurn[]): RootPromptMessage[] {
  const messages: RootPromptMessage[] = [];
  if (systemPrompt.trim()) messages.push(systemPromptMessage(systemPrompt));
  for (const turn of turns) messages.push(...turnMessages(turn));
  return messages;
}

export function encodeMessage(message: RootPromptMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}
