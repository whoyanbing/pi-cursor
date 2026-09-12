import { afterEach, describe, expect, it } from "vitest";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { connectNodeAdapter } from "@connectrpc/connect-node";
import {
  AgentClientMessageSchema,
  AgentServerMessageSchema,
  AgentService,
  ClientHeartbeatSchema,
  GetUsableModelsResponseSchema,
  InteractionUpdateSchema,
  ModelDetailsSchema,
  TextDeltaUpdateSchema,
  TurnEndedUpdateSchema,
  type AgentClientMessage,
  type AgentServerMessage,
} from "../proto/agent_pb.js";
import { agentClient, callHeaders, closeAllSessions, isRetriableTransportError, openRun, type RunStream } from "../transport/client.js";

function textDelta(text: string): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, { message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) } }),
    },
  });
}

function turnEnded(): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: {
      case: "interactionUpdate",
      value: create(InteractionUpdateSchema, { message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) } }),
    },
  });
}

function heartbeat(): AgentClientMessage {
  return create(AgentClientMessageSchema, { message: { case: "clientHeartbeat", value: create(ClientHeartbeatSchema, {}) } });
}

type RunImpl = (reqs: AsyncIterable<AgentClientMessage>, headers: Headers, signal: AbortSignal) => AsyncIterable<AgentServerMessage>;

async function listen(run: RunImpl): Promise<{ url: string; close: () => Promise<void> }> {
  const routes = (router: ConnectRouter) =>
    router.service(AgentService, {
      run: (reqs, ctx) => run(reqs, ctx.requestHeader, ctx.signal),
      getUsableModels: async (_req, ctx) => {
        if (!ctx.requestHeader.get("authorization")) throw new ConnectError("no token", Code.Unauthenticated);
        return create(GetUsableModelsResponseSchema, { models: [create(ModelDetailsSchema, { modelId: "gpt-5", displayName: "GPT-5" })] });
      },
    });
  const server = http2.createServer(connectNodeAdapter({ routes }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function collect(stream: RunStream): Promise<{ messages: AgentServerMessage[]; end: boolean; error?: Error }> {
  return new Promise((resolve) => {
    const messages: AgentServerMessage[] = [];
    stream.onMessage((m) => messages.push(m));
    stream.onEnd(() => resolve({ messages, end: true }));
    stream.onError((error) => resolve({ messages, end: false, error }));
  });
}

let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  closeAllSessions();
  await closeServer?.();
  closeServer = null;
});

describe("openRun", () => {
  it("streams bidirectionally with Cursor headers and ends cleanly", async () => {
    const seenHeaders: Record<string, string | null> = {};
    const server = await listen(async function* (reqs, headers) {
      seenHeaders.authorization = headers.get("authorization");
      seenHeaders.clientType = headers.get("x-cursor-client-type");
      seenHeaders.requestId = headers.get("x-request-id");
      for await (const req of reqs) {
        if (req.message.case === "clientHeartbeat") {
          yield textDelta("pong");
          yield turnEnded();
          return;
        }
      }
    });
    closeServer = server.close;

    const stream = openRun(server.url, "tok");
    const result = collect(stream);
    stream.send(heartbeat());
    const { messages, end } = await result;

    expect(end).toBe(true);
    expect(messages).toHaveLength(2);
    expect(messages[0].message.case).toBe("interactionUpdate");
    expect(seenHeaders.authorization).toBe("Bearer tok");
    expect(seenHeaders.clientType).toBe("cli");
    expect(seenHeaders.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(stream.alive).toBe(false);
  });

  it("surfaces a server error as onError with the Connect message", async () => {
    const server = await listen(async function* (reqs) {
      for await (const _ of reqs) {
        yield textDelta("partial");
        throw new ConnectError("model overloaded", Code.ResourceExhausted);
      }
    });
    closeServer = server.close;

    const stream = openRun(server.url, "tok");
    const result = collect(stream);
    stream.send(heartbeat());
    const { messages, error } = await result;

    expect(messages).toHaveLength(1);
    expect(error?.message).toContain("model overloaded");
  });

  it("destroy() cancels the stream and stops delivering", async () => {
    let cancelled = false;
    const server = await listen(async function* (reqs, _headers, signal) {
      for await (const _ of reqs) {
        yield textDelta("first");
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        cancelled = true;
        return;
      }
    });
    closeServer = server.close;

    const stream = openRun(server.url, "tok");
    const first = new Promise<void>((resolve) => stream.onMessage(() => resolve()));
    stream.onEnd(() => {
      throw new Error("must not end after destroy");
    });
    stream.onError(() => {
      throw new Error("must not error after destroy");
    });
    stream.send(heartbeat());
    await first;
    stream.destroy();
    expect(stream.alive).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cancelled).toBe(true);
  });

  it("fails with a retriable connection error when nothing is listening", async () => {
    const probe = http2.createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const stream = openRun(`http://127.0.0.1:${port}`, "tok");
    const { error } = await collect(stream);
    expect(error).toBeDefined();
    expect(isRetriableTransportError(error)).toBe(true);
  });
});

describe("agentClient unary", () => {
  it("calls GetUsableModels with call headers", async () => {
    const server = await listen(async function* () {});
    closeServer = server.close;
    const response = await agentClient(server.url).getUsableModels({}, { headers: callHeaders("tok") });
    expect(response.models.map((m) => m.modelId)).toEqual(["gpt-5"]);
  });

  it("maps HTTP-level auth failures to ConnectError", async () => {
    const server = await listen(async function* () {});
    closeServer = server.close;
    await expect(agentClient(server.url).getUsableModels({}, {})).rejects.toMatchObject({ code: Code.Unauthenticated });
  });
});
