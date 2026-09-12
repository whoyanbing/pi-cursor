/**
 * Cursor conversation ids must stay stable across the sub-turns of one Pi turn
 * (usage checkpoints are keyed by id) but rotate after Pi compaction.
 * Compaction rewrites the prompt Pi sends; if the id stays the same, Cursor
 * keeps the pre-compact transcript and `usedTokens` never drops — Pi then
 * re-triggers compact.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ParsedConversation } from "./context.js";

/** Hash of the first prompt text. Compaction replaces that text with a summary. */
export function conversationFingerprint(parsed: ParsedConversation): string {
  const first =
    parsed.completedTurns[0]?.userText ??
    (parsed.action.kind === "userMessage" ? parsed.action.text : "");
  return createHash("sha256").update(first).digest("hex").slice(0, 12);
}

const fallbackCache = new Map<string, string>();

export function __clearConversationIdCacheForTests(): void {
  fallbackCache.clear();
}

/** Stable within the process; restarts rotate so a new Pi process never
 * reuses a stale server-side transcript. */
function fallbackId(key: string): string {
  const hit = fallbackCache.get(key);
  if (hit) return hit;
  const id = `pi-${randomUUID().replace(/-/g, "").slice(0, 32)}`;
  fallbackCache.set(key, id);
  if (fallbackCache.size > 200) {
    const oldest = fallbackCache.keys().next();
    if (!oldest.done) fallbackCache.delete(oldest.value);
  }
  return id;
}

export function buildConversationId(
  parsed: ParsedConversation,
  modelId: string,
  sessionId?: string,
): string {
  const generation = conversationFingerprint(parsed);
  const session = sessionId?.trim();
  if (session) return `${session}:${modelId}:${generation}`;
  const key = createHash("sha256")
    .update(parsed.systemPrompt)
    .update("\0")
    .update(modelId)
    .update("\0")
    .update(generation)
    .digest("hex");
  return fallbackId(key);
}
