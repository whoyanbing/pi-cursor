/**
 * Streaming filter that splits model text into visible content and reasoning.
 *
 * Some Cursor models wrap reasoning in tags inside the *text* delta stream
 * (rather than using the dedicated thinking deltas). Tags may arrive split
 * across chunks, so a small tail is held back until it can be classified.
 */

const TAG_NAMES = ["think", "thinking", "reasoning", "thought", "think_intent"];
const TAG_PATTERN = new RegExp(`<(/?)(?:${TAG_NAMES.join("|")})\\s*>`, "gi");
/** Longest possible tag text, used to size the held-back tail. */
const MAX_TAG_LENGTH = Math.max(...TAG_NAMES.map((name) => `</${name}>`.length)) + 8;

export interface ThinkingSplit {
  content: string;
  reasoning: string;
}

export class ThinkingTagParser {
  private tail = "";
  private inReasoning = false;

  /** Split a text delta; returns the parts that are safe to emit now. */
  process(chunk: string): ThinkingSplit {
    const text = this.tail + chunk;
    this.tail = "";
    let content = "";
    let reasoning = "";
    let cursor = 0;

    TAG_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_PATTERN.exec(text)) !== null) {
      const before = text.slice(cursor, match.index);
      if (this.inReasoning) reasoning += before;
      else content += before;
      this.inReasoning = match[1] !== "/";
      cursor = match.index + match[0].length;
    }

    const rest = text.slice(cursor);
    // Hold back a trailing partial tag so the next chunk can complete it.
    const holdFrom = rest.lastIndexOf("<");
    if (holdFrom >= 0 && rest.length - holdFrom < MAX_TAG_LENGTH && /^<\/?[a-z_]*$/i.test(rest.slice(holdFrom))) {
      this.tail = rest.slice(holdFrom);
      const emit = rest.slice(0, holdFrom);
      if (this.inReasoning) reasoning += emit;
      else content += emit;
    } else if (this.inReasoning) {
      reasoning += rest;
    } else {
      content += rest;
    }

    return { content, reasoning };
  }

  /** Flush any held-back tail at end of stream. */
  flush(): ThinkingSplit {
    const rest = this.tail;
    this.tail = "";
    if (!rest) return { content: "", reasoning: "" };
    return this.inReasoning ? { content: "", reasoning: rest } : { content: rest, reasoning: "" };
  }

  reset(): void {
    this.tail = "";
    this.inReasoning = false;
  }
}

/** One-shot strip for complete (non-streamed) text. */
export function stripThinkingTags(text: string): string {
  const parser = new ThinkingTagParser();
  const first = parser.process(text);
  const flushed = parser.flush();
  return first.content + flushed.content;
}
