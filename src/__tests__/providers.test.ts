import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type ModelsPublication, type Provider, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";

const credentialsMock = vi.hoisted(() => ({
  resolveAccessToken: vi.fn(async () => ""),
  resolveCredential: vi.fn<(...args: unknown[]) => Promise<{ accessToken: string; source: string } | null>>(async () => null),
}));
vi.mock("../auth/credentials.js", () => credentialsMock);

const discoveryMock = vi.hoisted(() => ({
  discoverModels: vi.fn<(...args: unknown[]) => Promise<Array<{ id: string; name: string; contextWindow: number; maxTokens: number }>>>(async () => []),
}));
vi.mock("../models/discovery.js", () => discoveryMock);

function makePi() {
  const providers = new Map<string, Provider>();
  const commands = new Map<string, unknown>();
  return {
    providers, commands,
    registerProvider(provider: Provider) { providers.set(provider.id, provider); },
    registerCommand(name: string, options: unknown) { commands.set(name, options); },
    on: vi.fn(),
  };
}

async function activate() {
  const pi = makePi();
  const { default: load } = await import("../index.js");
  load(pi as never);
  return { pi, provider: pi.providers.get("cursor")! };
}

function refreshContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: vi.fn(async (publication: ModelsPublication) => { publication.update?.(); return true; }),
    ...overrides,
  };
}

const rawModels = [
  { id: "gpt-9", name: "GPT-9", contextWindow: 300_000, maxTokens: 64_000 },
  { id: "gpt-9-high", name: "GPT-9 High", contextWindow: 300_000, maxTokens: 64_000 },
];

beforeEach(() => {
  rmSync(join(homedir(), ".pi", "agent", "cursor-models-cache.json"), { force: true });
  vi.stubEnv("CURSOR_ACCESS_TOKEN", "");
});
afterEach(() => {
  rmSync(join(homedir(), ".pi", "agent", "cursor-models-cache.json"), { force: true });
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
  unregisterApiProviders("pi-cursor");
});

describe("extension registration", () => {
  it("registers a native provider, compatibility API and commands", async () => {
    const { pi, provider } = await activate();
    expect([...pi.providers.keys()]).toEqual(["cursor"]);
    expect(provider.name).toBe("Cursor");
    expect(provider.baseUrl).toMatch(/^https:\/\//);
    expect(typeof provider.streamSimple).toBe("function");
    const models = provider.getModels();
    expect(models.length).toBeGreaterThan(10);
    for (const model of models) {
      expect(model.api).toBe("cursor-native");
      expect(model.provider).toBe("cursor");
      expect(model.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    }
    expect(models.find(model => model.id.startsWith("gpt-5"))).toBeDefined();
    const oauth = provider.auth.oauth!;
    expect(oauth.name).toBe("Cursor");
    expect(oauth.isSubscription).toBe(true);
    expect(typeof oauth.login).toBe("function");
    expect(typeof oauth.refresh).toBe("function");
    expect(await oauth.toAuth({ type: "oauth", access: "a", refresh: "r", expires: 1 })).toEqual({ apiKey: "a" });
    expect(provider.auth.apiKey).toBeDefined();
    expect([...pi.commands.keys()].sort()).toEqual(["cursor.doctor", "cursor.model", "cursor.usage"]);
    for (const event of ["session_start", "session_before_compact", "session_compact", "turn_end", "session_tree", "model_select", "session_shutdown"]) {
      expect(pi.on).toHaveBeenCalledWith(event, expect.any(Function));
    }
    expect(getApiProvider("cursor-native")).toBeDefined();
  });

  it("makes env-only credentials available to the real Pi runtime", async () => {
    vi.stubEnv("CURSOR_ACCESS_TOKEN", "env-token");
    const { provider } = await activate();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider);
    expect(await runtime.checkAuth("cursor")).toEqual({ type: "api_key", source: "CURSOR_ACCESS_TOKEN" });
    expect((await runtime.getAuth("cursor"))?.auth.apiKey).toBe("env-token");
    expect((await runtime.getAvailable("cursor")).length).toBeGreaterThan(10);
  });

  it("resolves env credentials without reading or refreshing Pi's store", async () => {
    credentialsMock.resolveCredential.mockResolvedValue({ accessToken: "env-token", source: "env" });
    const { provider } = await activate();
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider);
    expect((await runtime.checkAuth("cursor"))?.source).toBe("env");
    expect(credentialsMock.resolveCredential).toHaveBeenCalledWith(expect.objectContaining({ skipPiStore: true, refresh: false }));
    expect((await runtime.getAuth("cursor"))?.auth.apiKey).toBe("env-token");
  });

  it("leaves stored OAuth refresh and persistence to Pi", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ accessToken: "new-token", refreshToken: "new-refresh" }))));
    const store = new InMemoryCredentialStore();
    await store.modify("cursor", async () => ({ type: "oauth", access: "old", refresh: "old-refresh", expires: 1 }));
    const { provider } = await activate();
    const runtime = await ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false });
    runtime.registerNativeProvider(provider);
    expect((await runtime.getAuth("cursor"))?.auth.apiKey).toBe("new-token");
    expect(await store.read("cursor")).toMatchObject({ access: "new-token", refresh: "new-refresh" });
    expect(credentialsMock.resolveCredential).not.toHaveBeenCalled();
  });

  it("does not start a cancelled OAuth login", async () => {
    const { provider } = await activate();
    const controller = new AbortController();
    controller.abort();
    const notify = vi.fn();
    await expect(provider.auth.oauth!.login({ signal: controller.signal, notify, prompt: vi.fn() })).rejects.toThrow();
    expect(notify).not.toHaveBeenCalled();
  });

  it("cancels polling when the Pi login dialog is dismissed", async () => {
    const { provider } = await activate();
    const controller = new AbortController();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(provider.auth.oauth!.login({
      signal: controller.signal, prompt: vi.fn(), notify: () => controller.abort(),
    })).rejects.toThrow(/abort/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps discovery offline-safe without network or credentials", async () => {
    const { provider } = await activate();
    await provider.refreshModels!(refreshContext({ allowNetwork: false }));
    await provider.refreshModels!(refreshContext());
    expect(provider.getModels().length).toBeGreaterThan(10);
    expect(discoveryMock.discoverModels).not.toHaveBeenCalled();
  });

  it("discovers, caches and publishes the complete catalog and routing", async () => {
    credentialsMock.resolveCredential.mockResolvedValue({ accessToken: "tok", source: "env" });
    discoveryMock.discoverModels.mockResolvedValue(rawModels);
    const { provider } = await activate();
    const context = refreshContext();
    await provider.refreshModels!(context);
    expect(discoveryMock.discoverModels).toHaveBeenCalledWith("tok", context.signal);
    const model = provider.getModels().find(model => model.id === "gpt-9");
    expect(model?.reasoning).toBe(true);
    expect(model?.thinkingLevelMap?.high).toBe("gpt-9-high");
    expect(context.publish).toHaveBeenCalledWith(expect.objectContaining({ persist: { models: provider.getModels(), checkedAt: expect.any(Number) } }));
  });

  it("does not update the catalog when publication is rejected", async () => {
    discoveryMock.discoverModels.mockResolvedValue(rawModels);
    const { provider } = await activate();
    const models = provider.getModels();
    await provider.refreshModels!(refreshContext({
      credential: { type: "api_key", key: "tok" }, publish: vi.fn(async () => false),
    }));
    expect(provider.getModels()).toBe(models);
  });

  it("keeps the current catalog on discovery failure", async () => {
    discoveryMock.discoverModels.mockRejectedValue(new Error("network down"));
    const { provider } = await activate();
    const models = provider.getModels();
    await provider.refreshModels!(refreshContext({ credential: { type: "api_key", key: "tok" } }));
    expect(provider.getModels()).toBe(models);
  });

  it("shows compact context status and clears it after a turn", async () => {
    const { pi } = await activate();
    const handler = (name: string) => pi.on.mock.calls.find(([event]) => event === name)![1] as (event: unknown, ctx: unknown) => void;
    const setStatus = vi.fn();
    const ctx = {
      model: { id: "gpt-5", provider: "cursor", api: "cursor-native", contextWindow: 256_000 },
      getSystemPrompt: () => "system rules",
      sessionManager: { getSessionId: () => "session-1", buildContextEntries: () => [] },
      ui: { setStatus },
    };
    handler("session_compact")({}, ctx);
    expect(setStatus).toHaveBeenCalledWith("pi-cursor-compact-context", expect.stringMatching(/^Cursor context ~\d+\.\d% after compact$/));
    handler("turn_end")({ message: { role: "assistant", usage: { totalTokens: 20_000 } } }, ctx);
    expect(setStatus).toHaveBeenLastCalledWith("pi-cursor-compact-context", undefined);
  });

  it("closes the HTTP/2 pool only on quit and reload", async () => {
    const { shouldCloseTransportOnShutdown } = await import("../index.js");
    expect(shouldCloseTransportOnShutdown("quit")).toBe(true);
    expect(shouldCloseTransportOnShutdown("reload")).toBe(true);
    expect(shouldCloseTransportOnShutdown("new")).toBe(false);
    expect(shouldCloseTransportOnShutdown("fork")).toBe(false);
    const { pi } = await activate();
    const handler = pi.on.mock.calls.find(([event]) => event === "session_shutdown")![1] as (event: unknown, ctx: unknown) => void;
    handler({ reason: "quit" }, { sessionManager: { getSessionId: () => "session-1" }, ui: { setStatus: vi.fn() } });
  });
});
