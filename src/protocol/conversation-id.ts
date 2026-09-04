/**
 * Cursor conversation ids must stay stable inside a turn (so a parked tool
 * bridge can resume) but rotate after Pi compaction. Compaction rewrites the
 * prompt Pi sends; if the id stays the same, Cursor keeps the pre-compact
 * transcript and `usedTokens` never drops — Pi then re-triggers compact.
 */
import { createHash } from "node:crypto";
import type { ParsedConversation } from "./context.js";

/** Hash of the first prompt text. Compaction replaces that text with a summary. */
export function conversationFingerprint(parsed: ParsedConversation): string {
  const first =
    parsed.completedTurns[0]?.userText ??
    (parsed.action.kind === "userMessage" ? parsed.action.text : "");
  return createHash("sha256").update(first).digest("hex").slice(0, 12);
}

export function buildConversationId(
  parsed: ParsedConversation,
  modelId: string,
  sessionId?: string,
): string {
  const generation = conversationFingerprint(parsed);
  const session = sessionId?.trim();
  if (session) return `${session}:${modelId}:${generation}`;
  const hash = createHash("sha256")
    .update(parsed.systemPrompt)
    .update("\0")
    .update(generation)
    .digest("hex")
    .slice(0, 32);
  return `pi-${hash}`;
}
