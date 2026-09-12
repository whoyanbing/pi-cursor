/**
 * Last-run diagnostics for `/cursor.doctor`.
 *
 * Deliberately minimal: only non-secret, operator-relevant facts (endpoints,
 * sizes, counts, timestamps, and the most recent error message). Token values
 * are never recorded here.
 */
import { registrySize } from "./models/registry.js";
import { cacheInfo } from "./models/catalog.js";
import { lastCredentialSource } from "./auth/credentials.js";
import { clientVersion, getAgentUrl } from "./config.js";

export interface RunDiagnostics {
  lastEndpoint?: string;
  lastRpcPath?: string;
  lastRequestBytes?: number;
  lastTurnEndedAt?: number;
  lastError?: string;
  runsStarted?: number;
  /** Wall time from streamCursor() to the first model output on that run. */
  lastFirstTokenMs?: number;
}

const state: RunDiagnostics = { runsStarted: 0 };

export function recordRun(update: Partial<RunDiagnostics>): void {
  Object.assign(state, update);
  if (update.lastRpcPath) state.runsStarted = (state.runsStarted ?? 0) + 1;
}

function ageMs(timestamp: number | undefined): string {
  if (!timestamp) return "never";
  return `${Math.round((Date.now() - timestamp) / 1000)}s ago`;
}

/** Sanitized multi-line diagnostics report. */
export function diagnosticsReport(tokenSource = lastCredentialSource() as string): string {
  const cache = cacheInfo();
  const lines = [
    `provider=cursor`,
    `api=cursor-native`,
    `agentUrl=${getAgentUrl()}`,
    `clientVersion=${clientVersion()}`,
    `tokenSource=${tokenSource}`,
    `registeredModels=${registrySize()}`,
    `modelCache=${cache.count} models, saved ${cache.savedAt ? ageMs(cache.savedAt) : "never"}, stale=${cache.stale ? "yes" : "no"}`,
    `runsStarted=${state.runsStarted ?? 0}`,
    `lastRpc=${state.lastRpcPath ?? "none"}`,
    `lastEndpoint=${state.lastEndpoint ?? "none"}`,
    `lastRequestBytes=${state.lastRequestBytes ?? "none"}`,
    `lastTurnEnded=${ageMs(state.lastTurnEndedAt)}`,
    `firstToken=${state.lastFirstTokenMs === undefined ? "n/a" : `${state.lastFirstTokenMs}ms`}`,
    `lastError=${state.lastError ?? "none"}`,
    `transport=connect-node/h2`,
    `commands=/cursor.model /cursor.usage /cursor.refresh /cursor.doctor`,
    "hint=On stalls check lastError; a connection that dies before any response retries once.",
    "hint=Tune PI_CURSOR_STREAM_IDLE_TIMEOUT_MS (silence watchdog, also bounds a hung handshake).",
    "hint=On auth errors re-run /login cursor.",
    "sampling=server-controlled (Cursor protocol has no temperature/top_p; pi sampling params are ignored).",
  ];
  return lines.join("\n");
}
