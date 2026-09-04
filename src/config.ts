/**
 * Endpoints, client identity, and tunables for the Cursor provider.
 *
 * Resolution order for the agent URL: env override → Cursor CLI config cache →
 * default. The CLI cache matters because Cursor rotates agent hostnames and the
 * locally installed CLI already knows the current one.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ID = "cursor";
export const PROVIDER_NAME = "Cursor";
export const CURSOR_API = "cursor-native";

export const DEFAULT_AGENT_URL = "https://agentn.us.api5.cursor.sh";
export const AUX_URL = "https://api2.cursor.sh";
export const DEFAULT_CLIENT_VERSION = "cli-2026.05.01-eea359f";

export const RUN_RPC = "/agent.v1.AgentService/Run";
export const USABLE_MODELS_RPC = "/agent.v1.AgentService/GetUsableModels";
export const AVAILABLE_MODELS_RPC = "/aiserver.v1.AiService/AvailableModels";
export const USAGE_URL = `${AUX_URL}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`;

export const LOGIN_URL = "https://cursor.com/loginDeepControl";
export const POLL_URL = `${AUX_URL}/auth/poll`;
export const REFRESH_URL = `${AUX_URL}/auth/exchange_user_api_key`;
export const DASHBOARD_URL = "https://cursor.com/dashboard?tab=usage";

export const MODEL_CACHE_FILE = "cursor-models-cache.json";
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const ZERO_COST = Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/** Connect streaming frame flag marking the final (possibly error) frame. */
export const CONNECT_END_STREAM_FLAG = 0b0000_0010;
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
export const MAX_ERROR_BODY_BYTES = 1024 * 1024;

/** Synthetic user message used to continue a turn after tool results. */
export const CONTINUE_TEXT = "Continue.";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

/** Silence watchdog for an in-flight run; 0 disables. */
export function streamIdleTimeoutMs(): number {
  return envInt("PI_CURSOR_STREAM_IDLE_TIMEOUT_MS", 180_000);
}

/** How long a paused bridge (waiting on pi to execute tools) may stay open. */
export function bridgeMaxPauseMs(): number {
  return envInt("PI_CURSOR_BRIDGE_PAUSE_MS", 15 * 60_000);
}

/** Client heartbeat cadence on an open Run stream. */
export function heartbeatIntervalMs(): number {
  return envInt("PI_CURSOR_HEARTBEAT_MS", HEARTBEAT_INTERVAL_MS);
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const H2_PING_INTERVAL_MS = 20_000;
export const CONNECT_TIMEOUT_MS = 30_000;

/** HTTP/2 handshake timeout; 0 disables. Does not cover first-token wait. */
export function connectTimeoutMs(): number {
  return envInt("PI_CURSOR_CONNECT_TIMEOUT_MS", CONNECT_TIMEOUT_MS);
}

export function clientVersion(): string {
  return process.env.PI_CURSOR_CLIENT_VERSION?.trim() || DEFAULT_CLIENT_VERSION;
}

export function normalizeBaseUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Agent URL cached by the locally installed Cursor CLI, if any. */
export function readCliAgentUrl(): string | undefined {
  const configDir = process.env.CURSOR_CONFIG_DIR?.trim() || join(homedir(), ".cursor");
  try {
    const config = JSON.parse(readFileSync(join(configDir, "cli-config.json"), "utf8")) as {
      serverConfigCache?: { agentUrlConfig?: { agentnUrl?: unknown; agentUrl?: unknown } };
    };
    const cache = config.serverConfigCache?.agentUrlConfig;
    return normalizeBaseUrl(cache?.agentnUrl) ?? normalizeBaseUrl(cache?.agentUrl);
  } catch {
    return undefined;
  }
}

/** How long a CLI-resolved agent host is reused before re-reading cli-config.json. */
export const AGENT_URL_TTL_MS = 30_000;

let cachedCliAgentUrl: { url: string | undefined; at: number } | null = null;

export function getAgentUrl(): string {
  const fromEnv =
    normalizeBaseUrl(process.env.PI_CURSOR_AGENT_URL) ??
    normalizeBaseUrl(process.env.CURSOR_AGENT_URL);
  if (fromEnv) return fromEnv;
  const now = Date.now();
  if (cachedCliAgentUrl && now - cachedCliAgentUrl.at < AGENT_URL_TTL_MS) {
    return cachedCliAgentUrl.url ?? DEFAULT_AGENT_URL;
  }
  const fromCli = readCliAgentUrl();
  cachedCliAgentUrl = { url: fromCli, at: now };
  return fromCli ?? DEFAULT_AGENT_URL;
}

/** Drop the CLI host cache (tests and /reload). Env overrides are never cached. */
export function resetAgentUrlCache(): void {
  cachedCliAgentUrl = null;
}
