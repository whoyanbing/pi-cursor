import { afterEach, describe, expect, it } from "vitest";
import {
  activeBridgeCount,
  clearAllBridges,
  clearBridgesForSession,
  peekBridge,
  storeBridge,
  type Bridge,
} from "../protocol/bridge.js";
import { BlobStore } from "../protocol/blobs.js";
import type { RunStream } from "../transport/client.js";

function fakeRpc(): RunStream {
  return {
    send() {},
    destroy() {},
    onMessage() {},
    onEnd() {},
    onError() {},
    get alive() {
      return true;
    },
  };
}

function fakeBridge(conversationId: string): Bridge {
  return {
    rpc: fakeRpc(),
    blobs: new BlobStore(),
    toolDefinitions: [],
    pendingExecs: new Map(),
    conversationId,
    baseUrl: "https://example",
    requestFingerprint: "test-config",
    pausedAt: Date.now(),
    heartbeatTimer: null,
  };
}

afterEach(() => {
  clearAllBridges();
});

describe("clearBridgesForSession", () => {
  it("drops only bridges for that session id", () => {
    storeBridge("sess-a:gpt-5:aaa", fakeBridge("sess-a:gpt-5:aaa"));
    storeBridge("sess-b:gpt-5:bbb", fakeBridge("sess-b:gpt-5:bbb"));
    clearBridgesForSession("sess-a");
    expect(peekBridge("sess-a:gpt-5:aaa")).toBeUndefined();
    expect(peekBridge("sess-b:gpt-5:bbb")).toBeDefined();
    expect(activeBridgeCount()).toBe(1);
  });
});
