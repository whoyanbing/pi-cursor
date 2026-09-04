/**
 * Context-window and output-token inference.
 *
 * GetUsableModels carries neither number, so both are inferred from the model
 * id/name; AvailableModels parameterized metadata *does* send contextTokenLimit
 * and wins when present.
 */

export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64_000;

/** GPT-5.6 default (272k short-context tier). */
const GPT56_DEFAULT_CONTEXT_WINDOW = 272_000;
/**
 * OpenAI-via-Cursor GPT-5.6 rejects prompts above this even when Cursor labels
 * the row "1M" (observed: `maximum prompt length is 500000`).
 */
const GPT56_MAX_PROMPT_TOKENS = 500_000;

function isGpt56(id: string, name: string): boolean {
  return /gpt-5\.6/.test(`${id} ${name}`.toLowerCase());
}

/** Cap GPT-5.6 windows at the real prompt limit; leave other families alone. */
export function clampContextWindow(id: string, name: string, window: number): number {
  if (isGpt56(id, name) && window > GPT56_MAX_PROMPT_TOKENS) return GPT56_MAX_PROMPT_TOKENS;
  return window;
}

export function inferContextWindow(id: string, name = ""): number {
  const idLower = id.toLowerCase();
  const text = `${idLower} ${name}`.toLowerCase();

  if (isGpt56(id, name)) {
    if (/(?:^|-)1m(?:-|$)/.test(idLower)) return GPT56_MAX_PROMPT_TOKENS;
    return GPT56_DEFAULT_CONTEXT_WINDOW;
  }
  if (/\b1\s*m\b|(?:^|-)1m(?:-|$)/.test(text)) return 1_000_000;
  if (/\b272\s*k\b|(?:^|-)272k(?:-|$)/.test(text)) return 272_000;
  if (/\b256\s*k\b|(?:^|-)256k(?:-|$)/.test(text)) return 256_000;
  // Grok 4.5/4.6 advertise 256K via contextTokenLimit; display names lack the
  // suffix. Do not match Grok 4.20 (`grok-4-20`).
  if (/grok[- ]4\.[56](?:\b|-)/.test(text)) return 256_000;
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Pi-side budgeting only — Cursor's run request has no max-output field, so a
 * wrong value here mis-sizes Pi's allowance but cannot fail a request.
 */
export function inferMaxOutputTokens(id: string, name = ""): number {
  const text = `${id} ${name}`.toLowerCase();
  // Claude 4.6+ documents a 128K output ceiling; 4.5 and earlier stay at 64K.
  if (/claude-(?:[5-9]|4\.(?:[6-9]|\d{2,}))/.test(text)) return 128_000;
  if (/\b(?:sonnet|opus)\s*(?:[5-9]|4\.(?:[6-9]|\d{2,}))/.test(text)) return 128_000;
  if (/\bgpt-5/.test(text)) return 128_000;
  return DEFAULT_MAX_OUTPUT_TOKENS;
}
