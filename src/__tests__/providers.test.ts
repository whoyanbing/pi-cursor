import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface ResolvedToken {
  accessToken: string;
  source: string;
}

interface RawModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

const credentialsMock = vi.hoisted(() => ({
  resolveAccessToken: vi.fn(async () => ""),
  resolveCredential: vi.fn<() => Promise<{ accessToken: string; source: string } | null>>(async () => null),
}));
vi.mock("../auth/credentials.js", () => credentialsMock);

const discoveryMock = vi.hoisted(() => ({
  discoverModels: vi.fn<() => Promise<Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>>>(
    async () => [],
  ),
}));
vi.mock("../models/discovery.js", () => discoveryMock);

import { getApiProvider, streamSimple, unregisterApiProviders } from "@earendil-works/pi-ai/compat";

interface CommandEntry {
  description?: string;
  handler: (args: string, ctx: unknown) => Promise<void>;
}

function makePi() {
  const providers = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, CommandEntry>();
  const pi = {
    providers,
    commands,
    registerProvider(providerID: string, config: Record<string, unknown>) {
      providers.set(providerID, config);
    },
    registerCommand(name: string, options: CommandEntry) {
      commands.set(name, options);
    },
    on: vi.fn(),
  };
  return pi;
}

/** Discovery writes the model cache; keep tests isolated from each other. */
beforeEach(() => {
  rmSync(join(homedir(), ".pi", "agent", "cursor-models-cache.json"), { force: true });
});

afterEach(() => {
  rmSync(join(homedir(), ".pi", "agent", "cursor-models-cache.json"), { force: true });
  vi.clearAllMocks();
  vi.resetModules();
});

describe("extension registration", () => {
  it("registers the cursor provider, api and commands", async () => {
    unregisterApiProviders("pi-cursor");
    const pi = makePi();
    const { default: activate } = await import("../index.js");
    await activate(pi as never);

    expect([...pi.providers.keys()]).toEqual(["cursor"]);
    const config = pi.providers.get("cursor")!;
    expect(config.api).toBe("cursor-native");
    expect(config.name).toBe("Cursor");
    expect(String(config.baseUrl)).toMatch(/^https:\/\//);
    expect(typeof config.streamSimple).toBe("function");

    // Models come from the bundled seeds: non-empty, all cursor-native.
    const models = config.models as Array<Record<string, unknown>>;
    expect(models.length).toBeGreaterThan(10);
    for (const model of models) {
      expect(model.api).toBe("cursor-native");
      expect(model.provider).toBe("cursor");
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
    // Effort-grouped seeds expose thinking maps of raw ids.
    const gpt = models.find((model) => String(model.id).startsWith("gpt-5"));
    expect(gpt).toBeDefined();

    const oauth = config.oauth as Record<string, unknown>;
    expect(oauth.name).toBe("Cursor");
    expect(oauth.isSubscription).toBe(true);
    expect(typeof oauth.login).toBe("function");
    expect(typeof oauth.refreshToken).toBe("function");
    expect(typeof oauth.getApiKey).toBe("function");
    expect(oauth.getApiKey).toBeDefined();
    expect((oauth.getApiKey as (c: { access: string }) => string)({ access: "a" })).toBe("a");

    expect([...pi.commands.keys()].sort()).toEqual(["cursor.doctor", "cursor.model", "cursor.usage"]);

    // The api registry resolves streamSimple for cursor-native models.
    expect(getApiProvider("cursor-native")).toBeDefined();
    const model = { id: "gpt-5", api: "cursor-native", provider: "cursor" } as never;
    expect(() => streamSimple(model, { systemPrompt: "", messages: [] })).not.toThrow(/No API provider registered/);
  });

  it("refreshModels stays offline-safe without network or credentials", async () => {
    unregisterApiProviders("pi-cursor");
    const pi = makePi();
    const { default: activate } = await import("../index.js");
    await activate(pi as never);

    const config = pi.providers.get("cursor")!;
    const refresh = config.refreshModels as (context: unknown) => Promise<Array<Record<string, unknown>>>;

    const offline = await refresh({
      allowNetwork: false,
      signal: new AbortController().signal,
      publish: vi.fn(async () => true),
    });
    expect(offline.length).toBeGreaterThan(10);
    expect(discoveryMock.discoverModels).not.toHaveBeenCalled();

    // Network allowed but no credential anywhere → still no discovery.
    const noToken = await refresh({
      allowNetwork: true,
      signal: new AbortController().signal,
      publish: vi.fn(async () => true),
    });
    expect(noToken.length).toBeGreaterThan(10);
    expect(discoveryMock.discoverModels).not.toHaveBeenCalled();
  });

  it("refreshModels discovers, caches and publishes when a token exists", async () => {
    unregisterApiProviders("pi-cursor");
    credentialsMock.resolveCredential.mockResolvedValueOnce({ accessToken: "tok", source: "env" } as ResolvedToken);
    discoveryMock.discoverModels.mockResolvedValueOnce([
      { id: "gpt-9", name: "GPT-9", contextWindow: 300_000, maxTokens: 64_000 },
      { id: "gpt-9-high", name: "GPT-9 High", contextWindow: 300_000, maxTokens: 64_000 },
    ] as RawModel[]);

    const pi = makePi();
    const { default: activate } = await import("../index.js");
    await activate(pi as never);

    const config = pi.providers.get("cursor")!;
    const refresh = config.refreshModels as (context: unknown) => Promise<Array<Record<string, unknown>>>;
    const publish = vi.fn(async () => true);
    const models = await refresh({
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
      publish,
    });

    expect(discoveryMock.discoverModels).toHaveBeenCalledWith("tok", expect.anything());
    // gpt-9 + gpt-9-high collapse into one pi model with a level map.
    const gpt9 = models.find((model) => model.id === "gpt-9");
    expect(gpt9).toBeDefined();
    expect(gpt9?.reasoning).toBe(true);
    expect((gpt9?.thinkingLevelMap as Record<string, unknown>).high).toBe("gpt-9-high");

    expect(publish).toHaveBeenCalledTimes(1);
    const publication = (publish as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      persist: { models: unknown[]; checkedAt: number };
    };
    expect(publication.persist.models.length).toBe(models.length);
    expect(publication.persist.checkedAt).toBeGreaterThan(0);
  });

  it("refreshModels falls back to the current catalog on discovery failure", async () => {
    unregisterApiProviders("pi-cursor");
    credentialsMock.resolveCredential.mockResolvedValueOnce({ accessToken: "tok", source: "env" } as ResolvedToken);
    discoveryMock.discoverModels.mockRejectedValueOnce(new Error("network down"));

    const pi = makePi();
    const { default: activate } = await import("../index.js");
    await activate(pi as never);

    const config = pi.providers.get("cursor")!;
    const refresh = config.refreshModels as (context: unknown) => Promise<Array<Record<string, unknown>>>;
    const models = await refresh({
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
      publish: vi.fn(async () => true),
    });
    expect(models.length).toBeGreaterThan(10);
  });
});
