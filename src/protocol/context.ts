/**
 * Parses Pi's `Context` into the turn-oriented shape Cursor expects.
 *
 * Cursor conversations are turns (user text + assistant steps + tool results),
 * not a flat message array. The trailing state decides how the next request is
 * framed:
 *
 *   - last message is a user message      → that text is the new action
 *   - last messages are assistant/tool    → the turn is in flight; its tool
 *     results are the tail, and the action is a synthetic "Continue."
 *
 * The tail tool-call ids double as the resume key for a live bridge: when they
 * match a paused stream's pending execs, the answer goes inline on that stream
 * instead of rebuilding the whole conversation.
 */
import type { Context, ImageContent, Message, TextContent, ToolCall } from "@earendil-works/pi-ai";

export interface ImagePart {
  data: Uint8Array;
  mimeType: string;
}

export interface ToolResultPayload {
  content: string;
  images: ImagePart[];
  isError: boolean;
}

export type TurnStep =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolCall"; toolCallId: string; toolName: string; arguments: Record<string, unknown>; result?: ToolResultPayload };

export interface ParsedTurn {
  userText: string;
  userImages: ImagePart[];
  steps: TurnStep[];
}

export type ConversationAction =
  | { kind: "userMessage"; text: string; images: ImagePart[] }
  | { kind: "continue"; turn: ParsedTurn };

export interface ParsedConversation {
  systemPrompt: string;
  /** Fully answered turns that become conversation history. */
  completedTurns: ParsedTurn[];
  /** What the next request should ask for. */
  action: ConversationAction;
  /** Tool-call ids answered by the trailing toolResult messages (resume key). */
  answeredToolCallIds: string[];
  /** True when trailing tool results follow an assistant tool-call message. */
  isToolContinuation: boolean;
}

function textFromContent(content: string | (TextContent | ImageContent)[] | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function imagesFromContent(content: string | (TextContent | ImageContent)[] | undefined): ImagePart[] {
  if (content == null || typeof content === "string") return [];
  const images: ImagePart[] = [];
  for (const part of content) {
    if (part.type !== "image") continue;
    const image = part as ImageContent;
    if (!image.data || !image.mimeType) continue;
    images.push({
      data: typeof image.data === "string" ? decodeBase64(image.data) : new Uint8Array(image.data),
      mimeType: image.mimeType,
    });
  }
  return images;
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value.replace(/\s/g, ""), "base64"));
}

function messageRole(message: { role: string }): string {
  return message.role;
}

function isUserLikeRole(role: string): boolean {
  return (
    role === "user" ||
    role === "compactionSummary" ||
    role === "branchSummary" ||
    role === "custom" ||
    role === "bashExecution"
  );
}

/** Cap replayed shell output: keep the tail, note the cut. */
const MAX_BASH_EXECUTION_CHARS = 8000;

function truncateTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `[pi-cursor truncated this earlier shell output to the last ${maxChars} chars.]\n…${text.slice(-maxChars)}`;
}

function userLikeText(message: Message): string {
  const record = message as unknown as {
    summary?: unknown;
    command?: unknown;
    output?: unknown;
    content?: string | (TextContent | ImageContent)[];
  };
  if (typeof record.summary === "string" && record.summary) return record.summary;
  if (typeof record.command === "string") {
    const output = typeof record.output === "string" ? record.output : "";
    const body = output ? `\n${truncateTail(output, MAX_BASH_EXECUTION_CHARS)}` : "";
    return `Ran \`${record.command}\`${body}`;
  }
  return textFromContent(record.content);
}

function findPendingToolCall(turns: ParsedTurn[], toolCallId: string): Extract<TurnStep, { kind: "toolCall" }> | undefined {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const steps = turns[i].steps;
    for (let j = steps.length - 1; j >= 0; j -= 1) {
      const step = steps[j];
      if (step.kind === "toolCall" && step.toolCallId === toolCallId && !step.result) return step;
    }
  }
  return undefined;
}

export function parseConversation(context: Context): ParsedConversation {
  const systemPrompt = typeof context.systemPrompt === "string" ? context.systemPrompt : "";
  const turns: ParsedTurn[] = [];
  let current: ParsedTurn | null = null;

  const ensureTurn = (): ParsedTurn => {
    if (!current) {
      current = { userText: "", userImages: [], steps: [] };
      turns.push(current);
    }
    return current;
  };

  const messages: Message[] = context.messages ?? [];
  for (const message of messages) {
    const role = messageRole(message);
    if (isUserLikeRole(role)) {
      // A new user-like message (including Pi compaction summaries) closes the previous turn.
      if (message.role === "user") {
        current = {
          userText: textFromContent(message.content),
          userImages: imagesFromContent(message.content),
          steps: [],
        };
      } else {
        current = { userText: userLikeText(message), userImages: [], steps: [] };
      }
      turns.push(current);
      continue;
    }

    const turn = ensureTurn();
    if (message.role === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "text") {
          if (block.text) turn.steps.push({ kind: "text", text: block.text });
        } else if (block.type === "thinking") {
          const thinking = (block as { thinking?: unknown }).thinking;
          if (typeof thinking === "string" && thinking) turn.steps.push({ kind: "thinking", text: thinking });
        } else if (block.type === "toolCall") {
          const call = block as ToolCall;
          turn.steps.push({
            kind: "toolCall",
            toolCallId: call.id,
            toolName: call.name,
            arguments: (call.arguments ?? {}) as Record<string, unknown>,
          });
        }
      }
      continue;
    }

    if (message.role !== "toolResult") continue;

    // toolResult
    const step = findPendingToolCall(turns, message.toolCallId);
    const payload: ToolResultPayload = {
      content: textFromContent(message.content),
      images: imagesFromContent(message.content),
      isError: message.isError === true,
    };
    if (step) step.result = payload;
    else turn.steps.push({ kind: "toolCall", toolCallId: message.toolCallId, toolName: message.toolName, arguments: {}, result: payload });
  }

  // Trailing answered tool-call ids: contiguous toolResult messages at the tail.
  const answeredToolCallIds: string[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "toolResult") break;
    answeredToolCallIds.unshift(message.toolCallId);
  }

  const last = messages[messages.length - 1];
  if (!last || isUserLikeRole(messageRole(last))) {
    const actionTurn = current ?? { userText: "", userImages: [], steps: [] };
    // The trailing user turn is the action, not history.
    const completed = turns.slice(0, -1);
    // Unanswered tool calls in history would stall the server prompt; drop them.
    for (const turn of completed) {
      turn.steps = turn.steps.filter((step) => step.kind !== "toolCall" || step.result);
    }
    return {
      systemPrompt,
      completedTurns: completed,
      action: { kind: "userMessage", text: actionTurn.userText, images: actionTurn.userImages },
      answeredToolCallIds,
      isToolContinuation: false,
    };
  }

  // In-flight turn: fold it into history and continue.
  for (const turn of turns) {
    turn.steps = turn.steps.filter((step) => step.kind !== "toolCall" || step.result);
  }
  const inFlight = turns[turns.length - 1] ?? { userText: "", userImages: [], steps: [] };
  return {
    systemPrompt,
    completedTurns: turns,
    action: { kind: "continue", turn: inFlight },
    answeredToolCallIds,
    isToolContinuation: answeredToolCallIds.length > 0,
  };
}
