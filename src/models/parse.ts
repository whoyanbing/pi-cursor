/**
 * Cursor model-id parsing.
 *
 * Cursor encodes reasoning effort, speed, and thinking variants as suffixes on
 * the raw model id (`claude-4.5-opus-high`, `gpt-5-fast`, `...-thinking-max`).
 * Pi instead wants one model with a thinking-level map, so ids are split into
 * (base, effort, fast, thinking) and grouped again later.
 */

const EFFORT_SUFFIXES: Array<{ suffix: string; effort: string }> = [
  { suffix: "extra-high", effort: "xhigh" },
  { suffix: "minimal", effort: "minimal" },
  { suffix: "xhigh", effort: "xhigh" },
  { suffix: "medium", effort: "medium" },
  { suffix: "high", effort: "high" },
  { suffix: "low", effort: "low" },
  { suffix: "max", effort: "max" },
  { suffix: "none", effort: "none" },
];

export interface ParsedModelId {
  /** Model id with effort stripped. */
  base: string;
  /** Effort level, or "" when the id carries none. */
  effort: string;
  fast: boolean;
  thinking: boolean;
}

function stripEffort(id: string): { remaining: string; effort: string } {
  for (const { suffix, effort } of EFFORT_SUFFIXES) {
    const marker = `-${suffix}`;
    if (id.endsWith(marker)) return { remaining: id.slice(0, -marker.length), effort };
  }
  return { remaining: id, effort: "" };
}

export function parseModelId(id: string): ParsedModelId {
  let remaining = id;
  let fast = false;
  let thinking = false;

  if (remaining.endsWith("-fast")) {
    fast = true;
    remaining = remaining.slice(0, -"-fast".length);
  }

  // Cursor has used both orderings for thinking/effort variants:
  //   claude-4.6-opus-max-thinking   (effort before -thinking)
  //   claude-opus-4-7-thinking-max   (effort after -thinking)
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -"-thinking".length);
    const parsed = stripEffort(remaining);
    remaining = parsed.remaining;
    return { base: remaining, effort: parsed.effort, fast, thinking };
  }

  const parsed = stripEffort(remaining);
  remaining = parsed.remaining;
  if (remaining.endsWith("-thinking")) {
    thinking = true;
    remaining = remaining.slice(0, -"-thinking".length);
  }
  return { base: remaining, effort: parsed.effort, fast, thinking };
}

/** Pi-facing id for a group: base plus thinking/fast markers, no effort. */
export function groupedModelId(base: string, thinking: boolean, fast: boolean): string {
  let id = base;
  if (thinking) id += "-thinking";
  if (fast) id += "-fast";
  return id;
}
