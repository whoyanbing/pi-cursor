/**
 * In-process HTTP/2 transport for Cursor's Connect RPCs.
 *
 * One persistent `http2` session per base URL is reused across turns and unary
 * calls; each RPC opens a fresh stream on it. Sessions are dropped (and lazily
 * reconnected) on GOAWAY, ping failure, or transport error — not when a stream
 * is torn down after a successful turn. The first retriable failure before any
 * response (handshake timeout, ETIMEDOUT, GOAWAY, reset) is retried once on a
 * fresh session, so a dead keep-alive does not fail the turn.
 *
 * `session.request()` is deferred until the peer's SETTINGS frame. Calling it
 * during a hung TCP handshake can block returning to the event loop, which
 * would prevent the connect timeout from ever firing.
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import {
  H2_PING_INTERVAL_MS,
  MAX_ERROR_BODY_BYTES,
  clientVersion,
  connectTimeoutMs,
} from "../config.js";

export interface StreamEndInfo {
  /** True when the server ended the stream with a 2xx status. */
  ok: boolean;
  status: number;
  /** Body collected for non-2xx responses (bounded). */
  errorBody?: string;
  /** Connect/grpc error message header when present. */
  statusText?: string;
}

export interface RpcStream {
  write(frame: Uint8Array): void;
  /** Half-close the request side; the response may keep streaming. */
  end(): void;
  /** Tear down the stream immediately. Does not drop the shared session. */
  destroy(): void;
  onData(cb: (chunk: Buffer) => void): void;
  onEnd(cb: (info: StreamEndInfo) => void): void;
  onError(cb: (error: Error) => void): void;
  readonly alive: boolean;
}

export interface OpenStreamOptions {
  rpcPath: string;
  token: string;
  /** Unary RPCs use `application/proto`; streaming uses `application/connect+proto`. */
  unary?: boolean;
  connectTimeoutMs?: number;
  signal?: AbortSignal;
}

interface SessionEntry {
  session: http2.ClientHttp2Session;
  pingTimer: ReturnType<typeof setInterval>;
  streams: number;
  /** True after the peer's HTTP/2 SETTINGS, not merely TCP connect. */
  connected: boolean;
  /** Set before fail() so a retry cannot reuse this dying session. */
  poisoned: boolean;
}

const sessions = new Map<string, SessionEntry>();

/** Destroy `expected` (or the mapped session). Never touches a newer replacement. */
function dropSession(baseUrl: string, expected?: SessionEntry): void {
  const mapped = sessions.get(baseUrl);
  const entry = expected ?? mapped;
  if (!entry) return;
  if (mapped === entry) sessions.delete(baseUrl);
  clearInterval(entry.pingTimer);
  try {
    entry.session.destroy();
  } catch {
    // Already gone.
  }
}

function getSession(baseUrl: string): SessionEntry {
  const existing = sessions.get(baseUrl);
  if (
    existing &&
    !existing.poisoned &&
    !existing.session.destroyed &&
    !existing.session.closed
  ) {
    return existing;
  }
  if (existing) dropSession(baseUrl, existing);

  const session = http2.connect(baseUrl);
  const entry: SessionEntry = {
    session,
    streams: 0,
    connected: false,
    poisoned: false,
    pingTimer: setInterval(() => {
      if (session.destroyed || session.closed) {
        dropSession(baseUrl, entry);
        return;
      }
      if (!entry.connected) return;
      try {
        session.ping((err) => {
          if (err) dropSession(baseUrl, entry);
        });
      } catch {
        dropSession(baseUrl, entry);
      }
    }, H2_PING_INTERVAL_MS),
  };
  entry.pingTimer.unref?.();

  session.on("remoteSettings", () => {
    entry.connected = true;
  });
  session.on("error", (error) => {
    entry.poisoned = true;
    dropSession(baseUrl, entry);
    void error;
  });
  session.on("goaway", () => dropSession(baseUrl, entry));
  session.on("close", () => dropSession(baseUrl, entry));

  sessions.set(baseUrl, entry);
  return entry;
}

/**
 * Maps an opaque HTTP/2 negotiation failure into something actionable. An
 * ALPN-stripping TLS proxy (e.g. Zscaler) makes the handshake negotiate no `h2`;
 * Cursor's RPCs are HTTP/2-only, so there is no fallback.
 */
export function describeTransportError(error: unknown, baseUrl: string): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ERR_HTTP2_ERROR" && /h2 is not supported/i.test(message)) {
    return (
      `Cursor transport could not negotiate HTTP/2 with ${baseUrl}: "h2 is not supported". ` +
      "This host serves Cursor's RPCs over HTTP/2 only, and the TLS handshake did not " +
      "negotiate h2 via ALPN — typically an ALPN-stripping TLS-intercepting proxy."
    );
  }
  if (code === "ETIMEDOUT" || /ETIMEDOUT/i.test(message)) {
    return (
      `Cursor transport timed out (${typeof code === "string" && code ? code : "ETIMEDOUT"}) ` +
      `talking to ${baseUrl}. The connection was dropped so the next request can reconnect.`
    );
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return `Cursor connection to ${baseUrl} was reset (${String(code)}).`;
  }
  return message;
}

/** True when a failure happened before any useful response and a fresh session may succeed. */
export function isRetriableTransportError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  const message = error instanceof Error ? error.message : String(error);
  return /ETIMEDOUT|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|connect timeout|GOAWAY|socket hang up|ECONNABORTED|SOCKET_UNBOUND|closed before handshake/i.test(
    `${code} ${message}`,
  );
}

function requestHeaders(rpcPath: string, token: string, unary: boolean): http2.OutgoingHttpHeaders {
  return {
    ":method": "POST",
    ":path": rpcPath,
    "content-type": unary ? "application/proto" : "application/connect+proto",
    "connect-protocol-version": "1",
    te: "trailers",
    authorization: `Bearer ${token}`,
    "x-ghost-mode": "true",
    "x-cursor-client-version": clientVersion(),
    "x-cursor-client-type": "cli",
    "x-request-id": randomUUID(),
  };
}

/** Wait until the peer SETTINGS arrives, or fail with a connect timeout. */
function waitForHandshake(
  baseUrl: string,
  entry: SessionEntry,
  rpcPath: string,
  timeout: number,
  signal?: AbortSignal,
): Promise<void> {
  if (entry.connected) return Promise.resolve();
  if (entry.poisoned || entry.session.destroyed || entry.session.closed) {
    return Promise.reject(new Error(`Cursor connection closed before handshake (${rpcPath})`));
  }
  if (signal?.aborted) return Promise.reject(new Error("Aborted"));

  return new Promise((resolve, reject) => {
    let settled = false;
    // `session.socket` is a Proxy over the underlying net.Socket. Once the
    // session tears down, any property access on it (e.g. `.off`, `.once`)
    // throws ERR_HTTP2_SOCKET_UNBOUND instead of returning undefined, so
    // every use below must be guarded — `finish()` runs from the session's
    // own `close`/`error` handlers, i.e. exactly when the socket is unbound.
    let socket: { off?: unknown; once?: unknown; setTimeout?: unknown } | undefined;
    try {
      socket = entry.session.socket as unknown as typeof socket;
    } catch {
      socket = undefined;
    }
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      // EventEmitter.off never throws, even after teardown.
      entry.session.off("remoteSettings", onReady);
      entry.session.off("close", onDead);
      entry.session.off("error", onDead);
      if (timer) clearTimeout(timer);
      try {
        entry.session.setTimeout(0);
      } catch {
        // Some test fakes omit setTimeout.
      }
      if (socket) {
        try {
          (socket.off as ((event: string, listener: () => void) => void) | undefined)?.call(
            socket,
            "timeout",
            onSocketTimeout,
          );
        } catch {
          // Proxy throws ERR_HTTP2_SOCKET_UNBOUND after session teardown.
        }
        try {
          (socket.setTimeout as ((ms: number) => void) | undefined)?.call(socket, 0);
        } catch {
          // Socket already gone.
        }
      }
      signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onReady = (): void => finish(() => resolve());
    const onDead = (): void =>
      finish(() => reject(new Error(`Cursor connection closed before handshake (${rpcPath})`)));
    const onAbort = (): void => finish(() => reject(new Error("Aborted")));
    const onTimeout = (): void => {
      finish(() => {
        entry.poisoned = true;
        dropSession(baseUrl, entry);
        reject(new Error(`Cursor connect timeout after ${timeout}ms (${rpcPath})`));
      });
    };
    const onSocketTimeout = (): void => onTimeout();
    const timer = timeout > 0 ? setTimeout(onTimeout, timeout) : null;
    if (timeout > 0) {
      try {
        entry.session.setTimeout(timeout, onTimeout);
      } catch {
        // Fake sessions used in tests may not implement setTimeout.
      }
      try {
        (socket as { setTimeout?: (ms: number) => void } | undefined)?.setTimeout?.(timeout);
      } catch {
        // Socket not yet attached, or already unbound.
      }
      try {
        (socket as { once?: (event: string, listener: () => void) => void } | undefined)?.once?.(
          "timeout",
          onSocketTimeout,
        );
      } catch {
        // Proxy throws ERR_HTTP2_SOCKET_UNBOUND after session teardown.
      }
    }

    entry.session.once("remoteSettings", onReady);
    entry.session.once("close", onDead);
    entry.session.once("error", onDead);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (entry.connected) onReady();
  });
}

/** Open a single Connect stream on the pooled session (no retry). */
function openRawStream(baseUrl: string, options: OpenStreamOptions): RpcStream {
  const { rpcPath, token, unary = false } = options;
  const entry = getSession(baseUrl);

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    end: null as ((info: StreamEndInfo) => void) | null,
    error: null as ((error: Error) => void) | null,
  };
  const queued: Buffer[] = [];
  const pendingWrites: Uint8Array[] = [];
  let finished = false;
  let halfClosed = false;
  let status = 0;
  let statusText = "";
  const errorChunks: Buffer[] = [];
  let errorBytes = 0;
  let pendingError: Error | null = null;
  let pendingEnd: StreamEndInfo | null = null;
  let stream: http2.ClientHttp2Stream | null = null;
  const handshakeAbort = new AbortController();

  const finish = (info: StreamEndInfo): void => {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener("abort", onAbort);
    handshakeAbort.abort();
    entry.streams = Math.max(0, entry.streams - 1);
    if (cbs.end) cbs.end(info);
    else pendingEnd = info;
  };
  const fail = (error: Error): void => {
    if (finished) return;
    finished = true;
    options.signal?.removeEventListener("abort", onAbort);
    handshakeAbort.abort();
    entry.streams = Math.max(0, entry.streams - 1);
    if (cbs.error) cbs.error(error);
    else pendingError = error;
  };

  // Finalize cancellation before destroy(): Node may emit a readable `end`
  // while tearing down the stream, which must never become a successful RPC.
  const onAbort = (): void => {
    fail(new Error("Aborted"));
    stream?.destroy();
  };

  entry.streams += 1;
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const isErrorStatus = (): boolean => status !== 0 && (status < 200 || status >= 300);

  const attach = (next: http2.ClientHttp2Stream): void => {
    stream = next;

    next.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
      statusText = String(headers["grpc-message"] ?? headers["connect-error-message"] ?? "");
    });

    next.on("data", (chunk: Buffer) => {
      if (isErrorStatus()) {
        const room = MAX_ERROR_BODY_BYTES - errorBytes;
        if (room > 0) {
          const kept = Buffer.from(chunk).subarray(0, room);
          errorChunks.push(kept);
          errorBytes += kept.byteLength;
        }
        return;
      }
      const payload = Buffer.from(chunk);
      if (cbs.data) cbs.data(payload);
      else queued.push(payload);
    });

    next.on("end", () => {
      if (isErrorStatus()) {
        finish({
          ok: false,
          status,
          statusText: statusText || undefined,
          errorBody: Buffer.concat(errorChunks).toString("utf8").trim() || undefined,
        });
        return;
      }
      finish({ ok: true, status: status || 200 });
    });

    next.on("close", () => {
      if (!finished) fail(new Error(`Cursor stream closed before response completed (${rpcPath})`));
    });

    next.on("error", (error) => {
      if (finished) return;
      entry.poisoned = true;
      fail(new Error(describeTransportError(error, baseUrl)));
      dropSession(baseUrl, entry);
    });

    for (const frame of pendingWrites) {
      if (finished || next.destroyed || next.closed) break;
      next.write(Buffer.from(frame));
    }
    pendingWrites.length = 0;
    if (halfClosed && !next.destroyed && !next.closed) {
      try {
        next.end();
      } catch {
        // Already finishing.
      }
    }
  };

  const timeout = options.connectTimeoutMs ?? connectTimeoutMs();
  const handshakeSignal = options.signal
    ? AbortSignal.any([options.signal, handshakeAbort.signal])
    : handshakeAbort.signal;

  void waitForHandshake(baseUrl, entry, rpcPath, timeout, handshakeSignal).then(
    () => {
      if (finished) return;
      if (entry.poisoned || entry.session.destroyed || entry.session.closed) {
        fail(new Error(`Cursor connection closed before handshake (${rpcPath})`));
        return;
      }
      try {
        attach(entry.session.request(requestHeaders(rpcPath, token, unary)));
      } catch (error) {
        fail(new Error(describeTransportError(error, baseUrl)));
      }
    },
    (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    },
  );

  return {
    write(frame) {
      if (finished) return;
      if (!stream || stream.destroyed || stream.closed) {
        pendingWrites.push(frame);
        return;
      }
      stream.write(Buffer.from(frame));
    },
    end() {
      halfClosed = true;
      if (!stream || stream.destroyed || stream.closed) return;
      try {
        stream.end();
      } catch {
        // Already finishing.
      }
    },
    destroy() {
      // Tear down this stream only. The pooled session stays warm for the next
      // turn; transport errors / GOAWAY / ping failure drop it separately.
      if (!finished) {
        finished = true;
        entry.streams = Math.max(0, entry.streams - 1);
      }
      options.signal?.removeEventListener("abort", onAbort);
      handshakeAbort.abort();
      try {
        stream?.destroy();
      } catch {}
    },
    onData(cb) {
      cbs.data = cb;
      while (queued.length > 0 && !finished) cb(queued.shift()!);
    },
    onEnd(cb) {
      cbs.end = cb;
      if (pendingEnd) {
        const info = pendingEnd;
        pendingEnd = null;
        cb(info);
      }
    },
    onError(cb) {
      cbs.error = cb;
      if (pendingError) {
        const error = pendingError;
        pendingError = null;
        cb(error);
      }
    },
    get alive() {
      return !finished && (!stream || (!stream.destroyed && !stream.closed));
    },
  };
}

/** Open a Connect stream (bidirectional unless `unary`), retrying once on a dead session. */
export function openStream(baseUrl: string, options: OpenStreamOptions): RpcStream {
  let inner = openRawStream(baseUrl, options);
  let retried = false;
  let gotProgress = false;
  let closed = false;
  let halfClosed = false;
  let generation = 0;
  const buffered: Uint8Array[] = [];
  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    end: null as ((info: StreamEndInfo) => void) | null,
    error: null as ((error: Error) => void) | null,
  };
  let pendingError: Error | null = null;
  let pendingEnd: StreamEndInfo | null = null;

  const bind = (): void => {
    const gen = ++generation;
    inner.onData((chunk) => {
      if (gen !== generation) return;
      gotProgress = true;
      buffered.length = 0;
      cbs.data?.(chunk);
    });
    inner.onEnd((info) => {
      if (gen !== generation) return;
      gotProgress = true;
      closed = true;
      buffered.length = 0;
      if (cbs.end) cbs.end(info);
      else pendingEnd = info;
    });
    inner.onError((error) => {
      if (gen !== generation) return;
      if (
        !retried &&
        !gotProgress &&
        !closed &&
        !options.signal?.aborted &&
        isRetriableTransportError(error)
      ) {
        retried = true;
        try {
          inner.destroy();
        } catch {
          // Inner already finished via the error path.
        }
        inner = openRawStream(baseUrl, options);
        bind();
        for (const frame of buffered) inner.write(frame);
        if (halfClosed) inner.end();
        return;
      }
      closed = true;
      if (cbs.error) cbs.error(error);
      else pendingError = error;
    });
  };
  bind();

  return {
    write(frame) {
      if (!gotProgress) buffered.push(frame);
      inner.write(frame);
    },
    end() {
      halfClosed = true;
      inner.end();
    },
    destroy() {
      closed = true;
      try {
        inner.destroy();
      } catch {}
    },
    onData(cb) {
      cbs.data = cb;
    },
    onEnd(cb) {
      cbs.end = cb;
      if (pendingEnd) {
        const info = pendingEnd;
        pendingEnd = null;
        cb(info);
      }
    },
    onError(cb) {
      cbs.error = cb;
      if (pendingError) {
        const error = pendingError;
        pendingError = null;
        cb(error);
      }
    },
    get alive() {
      return !closed && inner.alive;
    },
  };
}

/** One-shot unary RPC: send `body`, collect the response bytes. */
export function unaryRpc(
  baseUrl: string,
  options: OpenStreamOptions & { body: Uint8Array; timeoutMs?: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // Whole-RPC deadline, independent of the connection handshake deadline.
    // 0 explicitly disables it; discovery is bounded by default as well.
    const timeoutMs = options.timeoutMs ?? 30_000;
    const stream = openStream(baseUrl, { ...options, unary: true });
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      stream.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks));
    };
    const onAbort = (): void => finish(new Error("Aborted"));
    if (timeoutMs > 0) {
      timer = setTimeout(() => finish(new Error(`Cursor RPC timeout after ${timeoutMs}ms (${options.rpcPath})`)), timeoutMs);
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    stream.onData((chunk) => { if (!settled) chunks.push(chunk); });
    stream.onEnd((info) => {
      if (options.signal?.aborted) return onAbort();
      if (!info.ok) {
        const detail = info.statusText || info.errorBody || "request failed";
        finish(new Error(`Cursor HTTP ${info.status}: ${detail}`));
        return;
      }
      finish();
    });
    stream.onError((error) => finish(error));
    if (options.signal?.aborted) onAbort();
    if (!settled) {
      stream.write(options.body);
      stream.end();
    }
  });
}

/** Close every cached session (shutdown/tests). */
export function closeAllSessions(): void {
  for (const baseUrl of [...sessions.keys()]) dropSession(baseUrl);
}
