import { afterEach, describe, expect, it } from "vitest";
import http2 from "node:http2";
import net from "node:net";
import type { AddressInfo } from "node:net";
import {
  closeAllSessions,
  describeTransportError,
  isRetriableTransportError,
  openStream,
  type RpcStream,
  type StreamEndInfo,
} from "../transport/h2.js";

afterEach(() => {
  closeAllSessions();
});

describe("describeTransportError", () => {
  it("explains ALPN-stripped HTTP/2 failures", () => {
    const error = Object.assign(new Error("Protocol error: h2 is not supported"), { code: "ERR_HTTP2_ERROR" });
    expect(describeTransportError(error, "https://agent.example")).toMatch(/ALPN-stripping/);
  });

  it("explains socket timeouts", () => {
    const error = Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(describeTransportError(error, "https://agent.example")).toMatch(/timed out/);
    expect(describeTransportError(error, "https://agent.example")).toMatch(/agent.example/);
  });

  it("explains connection resets", () => {
    const error = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(describeTransportError(error, "https://agent.example")).toMatch(/reset/);
  });
});

describe("isRetriableTransportError", () => {
  it("retries handshake timeouts and common socket failures", () => {
    expect(isRetriableTransportError(new Error("Cursor connect timeout after 30000ms (/agent.v1.AgentService/Run)"))).toBe(
      true,
    );
    expect(isRetriableTransportError(Object.assign(new Error("read ETIMEDOUT"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isRetriableTransportError(new Error("Cursor GOAWAY on https://x: upstream connection closed (retriable)"))).toBe(
      true,
    );
    expect(isRetriableTransportError(new Error("socket hang up"))).toBe(true);
  });

  it("does not retry application errors", () => {
    expect(isRetriableTransportError(new Error("Cursor HTTP 401: unauthorized"))).toBe(false);
    expect(isRetriableTransportError(new Error("Not logged in to Cursor"))).toBe(false);
  });
});

function listenHttp2(
  onStream: (stream: http2.ServerHttp2Stream) => void,
): Promise<{ server: http2.Http2Server; url: string; sessions: () => number }> {
  const server = http2.createServer();
  let sessions = 0;
  server.on("session", () => {
    sessions += 1;
  });
  server.on("stream", onStream);
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, sessions: () => sessions });
    });
    server.on("error", reject);
  });
}

function waitEnd(stream: RpcStream): Promise<StreamEndInfo> {
  return new Promise((resolve, reject) => {
    stream.onEnd(resolve);
    stream.onError(reject);
  });
}

function waitError(stream: RpcStream): Promise<Error> {
  return new Promise((resolve, reject) => {
    stream.onEnd((info) => reject(new Error(`expected error, got end status=${info.status}`)));
    stream.onError(resolve);
  });
}

describe("http2 session pool", () => {
  it("reuses the session after a stream is destroyed", async () => {
    const { server, url, sessions } = await listenHttp2((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
      stream.end();
    });
    try {
      const first = openStream(url, { rpcPath: "/x", token: "t" });
      first.end();
      await waitEnd(first);
      first.destroy();

      const second = openStream(url, { rpcPath: "/x", token: "t" });
      second.end();
      await waitEnd(second);

      expect(sessions()).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("times out a hung handshake", async () => {
    // Drain inbound bytes so the client's HTTP/2 preface does not fill the
    // kernel buffer and stall the event loop. Never reply with SETTINGS.
    const server = net.createServer((socket) => {
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as AddressInfo).port;
    try {
      const stream = openStream(`http://127.0.0.1:${port}`, {
        rpcPath: "/agent.v1.AgentService/Run",
        token: "t",
        connectTimeoutMs: 150,
      });
      const error = await waitError(stream);
      expect(error.message).toMatch(/connect timeout after 150ms/);
    } finally {
      closeAllSessions();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
