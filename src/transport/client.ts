/**
 * Connect clients for Cursor's RPCs, over one pooled HTTP/2 session per host.
 *
 * `@connectrpc/connect-node` owns framing, unary/streaming semantics, keepalive
 * pings and reconnect-on-GOAWAY. This module adds Cursor's identity headers,
 * a push-style wrapper around the bidi `Run` stream, and one retry on a
 * connection that dies before the server said anything (a stale keep-alive
 * must not fail the turn).
 */
import { randomUUID } from "node:crypto";
import { Code, ConnectError, createClient, type Client, type Transport } from "@connectrpc/connect";
import { createConnectTransport, Http2SessionManager } from "@connectrpc/connect-node";
import { AgentService, type AgentClientMessage, type AgentServerMessage } from "../proto/agent_pb.js";
import { AiService } from "../proto/aiserver_pb.js";
import { H2_PING_INTERVAL_MS, clientVersion } from "../config.js";

interface Pool {
  manager: Http2SessionManager;
  transport: Transport;
}

const pools = new Map<string, Pool>();

function transportFor(baseUrl: string): Transport {
  let pool = pools.get(baseUrl);
  if (!pool) {
    // Ping while idle too: the session must survive the gap between turns.
    const manager = new Http2SessionManager(baseUrl, {
      pingIntervalMs: H2_PING_INTERVAL_MS,
      pingIdleConnection: true,
    });
    const transport = createConnectTransport({ baseUrl, httpVersion: "2", sessionManager: manager });
    pool = { manager, transport };
    pools.set(baseUrl, pool);
  }
  return pool.transport;
}

export function agentClient(baseUrl: string): Client<typeof AgentService> {
  return createClient(AgentService, transportFor(baseUrl));
}

export function aiClient(baseUrl: string): Client<typeof AiService> {
  return createClient(AiService, transportFor(baseUrl));
}

/** Per-call headers Cursor expects from a CLI client. */
export function callHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": clientVersion(),
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
}

/** Close every pooled session (shutdown/tests). The next call reconnects. */
export function closeAllSessions(): void {
  for (const pool of pools.values()) pool.manager.abort();
  pools.clear();
}

/**
 * Maps an opaque HTTP/2 negotiation failure into something actionable. An
 * ALPN-stripping TLS proxy (e.g. Zscaler) makes the handshake negotiate no `h2`;
 * Cursor's RPCs are HTTP/2-only, so there is no fallback.
 */
export function describeTransportError(error: unknown, baseUrl: string): string {
  const connect = ConnectError.from(error);
  const cause = connect.cause as { code?: unknown; message?: unknown } | undefined;
  const text = `${connect.rawMessage} ${String(cause?.code ?? "")} ${String(cause?.message ?? "")}`;
  if (/h2 is not supported/i.test(text)) {
    return (
      `Cursor transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
      "This host serves Cursor's RPCs over HTTP/2 only, and the TLS handshake did not " +
      "negotiate h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy."
    );
  }
  return connect.message;
}

/** True when a failure happened before any useful response and a fresh session may succeed. */
export function isRetriableTransportError(error: unknown): boolean {
  const connect = ConnectError.from(error);
  const cause = connect.cause as { code?: unknown; message?: unknown } | undefined;
  const text = `${connect.code} ${connect.rawMessage} ${String(cause?.code ?? "")} ${String(cause?.message ?? "")}`;
  return (
    connect.code === Code.Unavailable ||
    /ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|GOAWAY|socket hang up|ECONNABORTED|SOCKET_UNBOUND/i.test(text)
  );
}

/** Push-style async iterable feeding the request side of a bidi stream. */
class PushQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiter: ((result: IteratorResult<T>) => void) | null = null;
  private done = false;

  push(item: T): void {
    if (this.done) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.done = true;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = null;
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length > 0) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiter = resolve;
        });
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (error: unknown) => {
        this.end();
        return Promise.reject(error);
      },
    };
  }
}

export interface RunStream {
  send(message: AgentClientMessage): void;
  /** Tear down the stream. The pooled session stays warm for the next turn. */
  destroy(): void;
  readonly alive: boolean;
  onMessage(cb: (message: AgentServerMessage) => void): void;
  /** Server ended the stream cleanly (no trailing error). */
  onEnd(cb: () => void): void;
  onError(cb: (error: Error) => void): void;
}

/**
 * Open the bidi `Run` stream. Callbacks must be attached synchronously after
 * this returns (the consumer starts on the next microtask).
 */
export function openRun(baseUrl: string, token: string): RunStream {
  const cbs = {
    message: null as ((message: AgentServerMessage) => void) | null,
    end: null as (() => void) | null,
    error: null as ((error: Error) => void) | null,
  };
  let closed = false;
  let gotProgress = false;
  let retried = false;
  /** Outbound messages replayed on retry until the server has responded. */
  const buffered: AgentClientMessage[] = [];
  let queue = new PushQueue<AgentClientMessage>();
  let abort = new AbortController();

  const start = (): void => {
    const myQueue = queue;
    const mySignal = abort.signal;
    for (const message of buffered) myQueue.push(message);
    void (async () => {
      try {
        for await (const message of agentClient(baseUrl).run(myQueue, { headers: callHeaders(token), signal: mySignal })) {
          if (closed || myQueue !== queue) return;
          gotProgress = true;
          buffered.length = 0;
          cbs.message?.(message);
        }
        if (closed || myQueue !== queue) return;
        closed = true;
        cbs.end?.();
      } catch (raw) {
        if (closed || myQueue !== queue) return;
        if (!retried && !gotProgress && isRetriableTransportError(raw)) {
          retried = true;
          queue = new PushQueue();
          abort = new AbortController();
          start();
          return;
        }
        closed = true;
        cbs.error?.(new Error(describeTransportError(raw, baseUrl)));
      }
    })();
  };
  start();

  return {
    send(message) {
      if (closed) return;
      if (!gotProgress) buffered.push(message);
      queue.push(message);
    },
    destroy() {
      if (closed) return;
      closed = true;
      queue.end();
      abort.abort();
    },
    get alive() {
      return !closed;
    },
    onMessage(cb) {
      cbs.message = cb;
    },
    onEnd(cb) {
      cbs.end = cb;
    },
    onError(cb) {
      cbs.error = cb;
    },
  };
}
