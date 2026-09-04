/**
 * In-process HTTP/2 transport for Cursor's Connect RPCs.
 *
 * One persistent `http2` session per base URL is reused across turns and unary
 * calls; each RPC opens a fresh stream on it. Sessions are dropped (and lazily
 * reconnected) on GOAWAY or transport error.
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import {
  CONNECT_TIMEOUT_MS,
  H2_PING_INTERVAL_MS,
  MAX_ERROR_BODY_BYTES,
  clientVersion,
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
  /** Tear down the stream and its session immediately. */
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
}

const sessions = new Map<string, SessionEntry>();

function dropSession(baseUrl: string): void {
  const entry = sessions.get(baseUrl);
  if (!entry) return;
  sessions.delete(baseUrl);
  clearInterval(entry.pingTimer);
  try {
    entry.session.destroy();
  } catch {
    // Already gone.
  }
}

function getSession(baseUrl: string): SessionEntry {
  const existing = sessions.get(baseUrl);
  if (existing && !existing.session.destroyed && !existing.session.closed) return existing;
  if (existing) dropSession(baseUrl);

  const session = http2.connect(baseUrl);
  const entry: SessionEntry = { session, streams: 0, pingTimer: setInterval(() => {}, 1) };
  clearInterval(entry.pingTimer);
  entry.pingTimer = setInterval(() => {
    if (session.destroyed || session.closed) {
      dropSession(baseUrl);
      return;
    }
    try {
      session.ping(() => {});
    } catch {
      dropSession(baseUrl);
    }
  }, H2_PING_INTERVAL_MS);
  entry.pingTimer.unref?.();

  session.on("error", (error) => {
    dropSession(baseUrl);
    void error;
  });
  session.on("goaway", () => dropSession(baseUrl));
  session.on("close", () => dropSession(baseUrl));

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
  return message;
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

/** Open a Connect stream (bidirectional unless `unary`). */
export function openStream(baseUrl: string, options: OpenStreamOptions): RpcStream {
  const { rpcPath, token, unary = false } = options;
  const entry = getSession(baseUrl);

  const cbs = {
    data: null as ((chunk: Buffer) => void) | null,
    end: null as ((info: StreamEndInfo) => void) | null,
    error: null as ((error: Error) => void) | null,
  };
  const queued: Buffer[] = [];
  let finished = false;
  let status = 0;
  let statusText = "";
  const errorChunks: Buffer[] = [];
  let errorBytes = 0;

  const finish = (info: StreamEndInfo): void => {
    if (finished) return;
    finished = true;
    entry.streams = Math.max(0, entry.streams - 1);
    if (!unary && entry.streams === 0) {
      // Keep the session warm for the next turn; the ping timer maintains it.
    }
    cbs.end?.(info);
  };
  const fail = (error: Error): void => {
    if (finished) return;
    finished = true;
    entry.streams = Math.max(0, entry.streams - 1);
    cbs.error?.(error);
  };

  const stream = entry.session.request(requestHeaders(rpcPath, token, unary));
  entry.streams += 1;

  if (options.signal) {
    if (options.signal.aborted) {
      try {
        stream.destroy();
      } catch {}
    } else {
      options.signal.addEventListener(
        "abort",
        () => {
          try {
            stream.destroy();
          } catch {}
        },
        { once: true },
      );
    }
  }

  const isErrorStatus = (): boolean => status !== 0 && (status < 200 || status >= 300);

  stream.on("response", (headers) => {
    status = Number(headers[":status"] ?? 0);
    statusText = String(headers["grpc-message"] ?? headers["connect-error-message"] ?? "");
  });

  stream.on("data", (chunk: Buffer) => {
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

  stream.on("end", () => {
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

  stream.on("error", (error) => {
    fail(new Error(describeTransportError(error, baseUrl)));
    dropSession(baseUrl);
  });

  entry.session.once("goaway", () => {
    fail(new Error(`Cursor GOAWAY on ${baseUrl}: upstream connection closed (retriable)`));
  });

  const connectTimeout = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (status === 0 && !finished) {
      fail(new Error(`Cursor connect timeout after ${connectTimeout}ms (${rpcPath})`));
      try {
        stream.destroy();
      } catch {}
      dropSession(baseUrl);
    }
  }, connectTimeout);
  timer.unref?.();
  const clearConnectTimer = (): void => clearTimeout(timer);
  stream.once("response", clearConnectTimer);

  return {
    write(frame) {
      if (finished || stream.destroyed || stream.closed) return;
      stream.write(Buffer.from(frame));
    },
    end() {
      if (stream.destroyed || stream.closed) return;
      try {
        stream.end();
      } catch {
        // Already finishing.
      }
    },
    destroy() {
      // Intentional teardown by the caller (turn finished, bridge dropped).
      // Mark finished first so the underlying stream's error/close events do
      // not surface a spurious "destroyed" end after the caller already
      // finalized with the real reason.
      clearConnectTimer();
      if (!finished) {
        finished = true;
        entry.streams = Math.max(0, entry.streams - 1);
      }
      try {
        stream.destroy();
      } catch {}
      dropSession(baseUrl);
    },
    onData(cb) {
      cbs.data = cb;
      while (queued.length > 0 && !finished) cb(queued.shift()!);
    },
    onEnd(cb) {
      cbs.end = cb;
    },
    onError(cb) {
      cbs.error = cb;
    },
    get alive() {
      return !finished && !stream.destroyed && !stream.closed;
    },
  };
}

/** One-shot unary RPC: send `body`, collect the response bytes. */
export function unaryRpc(
  baseUrl: string,
  options: OpenStreamOptions & { body: Uint8Array; timeoutMs?: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const stream = openStream(baseUrl, { ...options, unary: true });
    const chunks: Buffer[] = [];
    stream.onData((chunk) => chunks.push(chunk));
    stream.onEnd((info) => {
      if (!info.ok) {
        const detail = info.statusText || info.errorBody || "request failed";
        reject(new Error(`Cursor HTTP ${info.status}: ${detail}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    stream.onError(reject);
    stream.write(options.body);
    stream.end();
  });
}

/** Close every cached session (shutdown/tests). */
export function closeAllSessions(): void {
  for (const baseUrl of [...sessions.keys()]) dropSession(baseUrl);
}
