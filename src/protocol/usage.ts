import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { parseConversation } from "./context.js";
import { buildHistory } from "./prompt.js";

/**
 * Cursor checkpoint usage is occasionally missing on tool sub-turns and can
 * emit a one-off low value on a still-growing conversation. Keep a small,
 * process-local last-good value per Cursor conversation so those frames do not
 * make Pi's context footer disappear or flash down and back up.
 */
const inputByConversation = new Map<string, number>();

/** Drops smaller than this fraction of the previous value are treated as bad frames. */
export const SUSPICIOUS_INPUT_DROP_RATIO = 0.5;

function stabilize(previous: number, reported: number): number {
  if (previous > 0 && reported < previous * SUSPICIOUS_INPUT_DROP_RATIO) return previous;
  return reported;
}

/** A real Pi compaction rotates the conversation id, so genuine drops are accepted. */
export function stabilizeInputTokens(conversationId: string, reported: number): number {
  if (!Number.isFinite(reported) || reported <= 0) return inputByConversation.get(conversationId) ?? 0;
  const tokens = Math.floor(reported);
  const stable = stabilize(inputByConversation.get(conversationId) ?? 0, tokens);
  inputByConversation.set(conversationId, stable);
  return stable;
}

export function cachedInputTokens(conversationId: string): number {
  return inputByConversation.get(conversationId) ?? 0;
}

export function clearUsageForSession(sessionId: string): void {
  const id = sessionId.trim();
  if (!id) return;
  const prefix = `${id}:`;
  for (const key of inputByConversation.keys()) {
    if (key === id || key.startsWith(prefix)) inputByConversation.delete(key);
  }
}

export function clearAllUsage(): void {
  inputByConversation.clear();
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const text = (part as Record<string, unknown>).text;
      return typeof text === "string" ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function toolDefinitionChars(context: Context): number {
  let chars = 0;
  for (const tool of context.tools ?? []) {
    chars += tool.name.length + (tool.description?.length ?? 0);
    try {
      chars += JSON.stringify(tool.parameters ?? {}).length;
    } catch {
      // Ignore unserializable schemas in the fallback estimate.
    }
  }
  return chars;
}

function promptTokensFromUsage(message: Context["messages"][number]): number {
  if (message.role !== "assistant") return 0;
  const usage = message.usage;
  const components = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
  const fromTotal = Math.max(0, (usage.totalTokens ?? 0) - (usage.output ?? 0));
  return Math.max(components, fromTotal);
}

/**
 * Recover the last credible prompt size already persisted in Pi's Context.
 * This also survives `/reload`: a lone 230k -> 17k report is rejected while a
 * normal 162k -> 130k adjustment is retained. Pre-compaction messages are
 * ignored using the summary timestamp, because their usage is deliberately
 * stale even though Pi keeps some of them after the summary.
 */
const SUMMARY_PREFIXES = [
  "The conversation history before this point was compacted into the following summary:",
  "The following is a summary of a branch that this conversation came back from:",
];

function isSummaryBoundary(message: Context["messages"][number]): boolean {
  const record = message as unknown as Record<string, unknown>;
  if (record.role === "compactionSummary" || record.role === "branchSummary") return true;
  if (record.role !== "user") return false;
  const text = contentText(record.content).trimStart();
  return SUMMARY_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function contextInputTokens(context: Context, model: Model<Api>): number {
  let boundary = 0;
  for (const message of context.messages ?? []) {
    if (!isSummaryBoundary(message)) continue;
    const timestamp = typeof message.timestamp === "number" ? message.timestamp : 0;
    boundary = Math.max(boundary, timestamp);
  }

  let stable = 0;
  for (const message of context.messages ?? []) {
    if (message.role !== "assistant") continue;
    if (message.provider !== model.provider || message.model !== model.id) continue;
    if (boundary > 0 && (message.timestamp ?? 0) <= boundary) continue;
    const tokens = promptTokensFromUsage(message);
    if (tokens <= 0) continue;
    stable = stabilize(stable, tokens);
  }
  return stable;
}

/**
 * Conservative provider-side seed used until Cursor sends a checkpoint.
 * A compacted Context already contains just the summary and kept messages, so
 * this seed drops immediately after compaction instead of inheriting 94%.
 */
export function estimatePromptTokens(model: Model<Api>, context: Context): number {
  const parsed = parseConversation(context);
  let chars = toolDefinitionChars(context);
  for (const message of buildHistory(parsed.systemPrompt, parsed.completedTurns)) {
    chars += JSON.stringify(message).length;
  }
  if (parsed.action.kind === "userMessage") {
    chars += parsed.action.text.length + parsed.action.images.length * 4800;
  } else {
    chars += "Continue.".length;
  }
  const estimated = Math.ceil(chars / 4);
  if (estimated <= 0) return 0;
  const window = model.contextWindow ?? 0;
  // A fallback estimate must not manufacture an auto-compaction by itself.
  return window > 0 ? Math.min(estimated, Math.max(1, window - 32_768)) : estimated;
}
