/**
 * Live bridge registry.
 *
 * Cursor's Run stream stays open while the model waits for tool results, but
 * Pi's streaming contract ends the call at `stopReason: "toolUse"` and runs the
 * tools out-of-band. The bridge closes that gap: when a turn pauses on exec
 * messages we park the open stream here, keyed by conversation. The next call —
 * carrying the tool results — finds the bridge and answers the execs inline on
 * the same stream instead of rebuilding the whole conversation.
 *
 * Only one bridge per conversation is kept; a stale one (tool-call mismatch,
 * expired pause, dead stream) is dropped and the caller falls back to a fresh
 * rebuild request.
 */
import type { RpcStream } from "../transport/h2.js";
import type { FrameParser } from "../transport/connect.js";
import type { BlobStore } from "./blobs.js";
import type { McpToolDefinition } from "../proto/agent_pb.js";
import { bridgeMaxPauseMs } from "../config.js";

export interface PendingExec {
  execMsgId: number;
  execId: string;
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  /** True once the tool call was emitted into a Pi assistant message. */
  surfaced: boolean;
}

export interface Bridge {
  rpc: RpcStream;
  parser: FrameParser;
  blobs: BlobStore;
  toolDefinitions: McpToolDefinition[];
  pendingExecs: Map<string, PendingExec>;
  conversationId: string;
  baseUrl: string;
  pausedAt: number;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

const bridges = new Map<string, Bridge>();

export function storeBridge(conversationId: string, bridge: Bridge): void {
  const existing = bridges.get(conversationId);
  if (existing && existing !== bridge) destroyBridge(existing);
  bridges.set(conversationId, bridge);
}

export function takeBridge(conversationId: string): Bridge | undefined {
  const bridge = bridges.get(conversationId);
  if (!bridge) return undefined;
  bridges.delete(conversationId);
  return bridge;
}

export function peekBridge(conversationId: string): Bridge | undefined {
  return bridges.get(conversationId);
}

export function destroyBridge(bridge: Bridge): void {
  if (bridge.heartbeatTimer) clearInterval(bridge.heartbeatTimer);
  bridge.heartbeatTimer = null;
  try {
    bridge.rpc.destroy();
  } catch {
    // Already gone.
  }
}

export function isBridgeExpired(bridge: Bridge): boolean {
  const maxPause = bridgeMaxPauseMs();
  return maxPause > 0 && Date.now() - bridge.pausedAt > maxPause;
}

/**
 * True when the trailing tool results in Pi's context answer exactly the execs
 * this bridge is parked on — the resume condition.
 */
export function bridgeMatchesResults(bridge: Bridge, answeredToolCallIds: readonly string[]): boolean {
  if (answeredToolCallIds.length === 0) return false;
  if (bridge.pendingExecs.size === 0) return false;
  const pending = new Set(bridge.pendingExecs.keys());
  return answeredToolCallIds.every((id) => pending.has(id));
}

/** Sweep expired/dead bridges (called opportunistically on each stream start). */
export function sweepBridges(): void {
  for (const [id, bridge] of [...bridges]) {
    if (isBridgeExpired(bridge) || !bridge.rpc.alive) {
      bridges.delete(id);
      destroyBridge(bridge);
    }
  }
}

export function activeBridgeCount(): number {
  return bridges.size;
}

/**
 * Drop parked Run streams for one Pi session. Conversation ids are
 * `{sessionId}:{modelId}:{fingerprint}`; other sessions stay parked.
 */
export function clearBridgesForSession(sessionId: string): void {
  const id = sessionId.trim();
  if (!id) return;
  const prefix = `${id}:`;
  for (const [key, bridge] of [...bridges]) {
    if (key === id || key.startsWith(prefix)) {
      bridges.delete(key);
      destroyBridge(bridge);
    }
  }
}

/** Destroy and clear every parked bridge (tests, or when the session id is unknown). */
export function clearAllBridges(): void {
  for (const bridge of bridges.values()) destroyBridge(bridge);
  bridges.clear();
}
