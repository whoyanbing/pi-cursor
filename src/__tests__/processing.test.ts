import { afterEach, describe, expect, it } from "vitest";
import { processAndRegister, processModels, toProviderModels } from "../models/processing.js";
import { clearRouting, lookupRouting, registrySize, resolveRouteTarget } from "../models/registry.js";
import type { CursorModel } from "../models/types.js";

function raw(id: string, extra: Partial<CursorModel> = {}): CursorModel {
  return {
    id,
    name: extra.name ?? id,
    contextWindow: extra.contextWindow ?? 200_000,
    maxTokens: extra.maxTokens ?? 64_000,
    ...extra,
  };
}

describe("processModels", () => {
  afterEach(() => clearRouting());

  it("keeps a bare model as-is", () => {
    const { models } = processModels([raw("grok-4")]);
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({ id: "grok-4", reasoning: false, defaultRawId: "grok-4" });
    expect(models[0].thinkingLevelMap).toBeUndefined();
  });

  it("collapses effort variants into one model with a level map of raw ids", () => {
    const { models, registry } = processModels([
      raw("gpt-5"),
      raw("gpt-5-low"),
      raw("gpt-5-medium"),
      raw("gpt-5-high"),
      raw("gpt-5-xhigh"),
      raw("gpt-5-none"),
    ]);
    expect(models).toHaveLength(1);
    const model = models[0];
    expect(model.id).toBe("gpt-5");
    expect(model.reasoning).toBe(true);
    expect(model.thinkingLevelMap).toEqual({
      off: "gpt-5-none",
      minimal: null,
      low: "gpt-5-low",
      medium: "gpt-5-medium",
      high: "gpt-5-high",
      xhigh: "gpt-5-xhigh",
      max: null,
    });
    expect(model.defaultRawId).toBe("gpt-5-medium");
    expect(registry.get("gpt-5")?.routes["gpt-5-high"]).toEqual({ modelId: "gpt-5-high" });
  });

  it("falls back to the bare id for medium when no -medium row exists", () => {
    const { models } = processModels([raw("claude-4.5-opus"), raw("claude-4.5-opus-high")]);
    expect(models[0].thinkingLevelMap?.medium).toBe("claude-4.5-opus");
    expect(models[0].defaultRawId).toBe("claude-4.5-opus");
  });

  it("groups fast and thinking variants separately", () => {
    const { models } = processModels([
      raw("composer-1-fast-low"),
      raw("composer-1-fast-high"),
      raw("claude-4-sonnet-thinking"),
    ]);
    const ids = models.map((m) => m.id).sort();
    expect(ids).toEqual(["claude-4-sonnet-thinking", "composer-1-fast"]);
    const composer = models.find((m) => m.id === "composer-1-fast")!;
    expect(composer.reasoning).toBe(true);
    const thinking = models.find((m) => m.id === "claude-4-sonnet-thinking")!;
    // A lone -thinking row is a distinct model, reasoning flagged, no level map.
    expect(thinking.reasoning).toBe(true);
    expect(thinking.thinkingLevelMap).toBeUndefined();
  });

  it("strips a mandatory effort suffix from single-variant groups", () => {
    const { models } = processModels([raw("claude-4.5-opus-high")]);
    expect(models[0].id).toBe("claude-4.5-opus");
    expect(models[0].defaultRawId).toBe("claude-4.5-opus-high");
    expect(models[0].thinkingLevelMap?.high).toBe("claude-4.5-opus-high");
  });

  it("carries parameterized routing through the registry", () => {
    const { registry } = processModels([
      raw("gpt-5.5-high", {
        requestedModelId: "gpt-5.5",
        parameters: [{ id: "reasoning", value: "high" }],
        requiresMaxMode: true,
      }),
      raw("gpt-5.5-low", { requestedModelId: "gpt-5.5", parameters: [{ id: "reasoning", value: "low" }] }),
    ]);
    const entry = registry.get("gpt-5.5")!;
    expect(entry.routes["gpt-5.5-high"]).toEqual({
      modelId: "gpt-5.5",
      maxMode: true,
      parameters: [{ id: "reasoning", value: "high" }],
    });
    expect(entry.routes["gpt-5.5-low"].maxMode).toBeUndefined();
  });

  it("sorts models by id", () => {
    const { models } = processModels([raw("zeta"), raw("alpha")]);
    expect(models.map((m) => m.id)).toEqual(["alpha", "zeta"]);
  });
});

describe("registry", () => {
  afterEach(() => clearRouting());

  it("processAndRegister publishes routing", () => {
    processAndRegister([raw("gpt-5-low"), raw("gpt-5-high")]);
    expect(registrySize()).toBe(1);
    expect(lookupRouting("gpt-5")?.defaultRawId).toBe("gpt-5-low");
  });

  it("resolveRouteTarget falls back to the raw id when unregistered", () => {
    clearRouting();
    expect(resolveRouteTarget("unknown-model", undefined)).toEqual({ modelId: "unknown-model" });
    expect(resolveRouteTarget("unknown-model", "unknown-model-high")).toEqual({ modelId: "unknown-model-high" });
  });

  it("resolveRouteTarget prefers the level raw id, then defaults", () => {
    processAndRegister([raw("gpt-5"), raw("gpt-5-high")]);
    expect(resolveRouteTarget("gpt-5", "gpt-5-high").modelId).toBe("gpt-5-high");
    expect(resolveRouteTarget("gpt-5", undefined).modelId).toBe("gpt-5");
    expect(resolveRouteTarget("gpt-5", "gpt-5-nope").modelId).toBe("gpt-5-nope");
  });
});

describe("toProviderModels", () => {
  afterEach(() => clearRouting());

  it("maps processed models to pi provider configs", () => {
    const { models } = processModels([
      raw("gpt-5", { supportsImages: true, contextWindow: 272_000, maxTokens: 128_000 }),
      raw("gpt-5-high", { supportsImages: true }),
      raw("text-only", { supportsImages: false }),
    ]);
    const configs = toProviderModels(models);
    const gpt5 = configs.find((c) => c.id === "gpt-5")!;
    expect(gpt5).toMatchObject({
      api: "cursor-native",
      provider: "cursor",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 272_000,
      maxTokens: 128_000,
    });
    expect(gpt5.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(gpt5.thinkingLevelMap?.high).toBe("gpt-5-high");
    const textOnly = configs.find((c) => c.id === "text-only")!;
    expect(textOnly.input).toEqual(["text"]);
    expect(textOnly.reasoning).toBe(false);
    expect(textOnly.baseUrl).toMatch(/^https:\/\//);
  });
});
