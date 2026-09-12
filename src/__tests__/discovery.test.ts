import { describe, expect, it } from "vitest";
import { mergeModels } from "../models/discovery.js";
import type { CursorModel, ParameterizedModel } from "../models/types.js";

describe("mergeModels", () => {
  const usable: CursorModel[] = [
    { id: "auto", name: "Auto", contextWindow: 200_000, maxTokens: 64_000, requestedModelId: "default" },
    { id: "gpt-5.5-high", name: "GPT-5.5 High", contextWindow: 200_000, maxTokens: 64_000 },
    { id: "claude-4.5-opus", name: "Opus", contextWindow: 200_000, maxTokens: 64_000 },
  ];

  it("attaches parameterized metadata by variant representation", () => {
    const parameterized: ParameterizedModel[] = [
      {
        name: "gpt-5.5",
        serverModelName: "gpt-5.5-server",
        supportsImages: true,
        contextTokenLimit: 272_000,
        variants: [
          {
            parameters: [{ id: "reasoning", value: "high" }],
            isMaxMode: false,
            variantStringRepresentation: "gpt-5.5-high",
          },
        ],
      },
    ];
    const merged = mergeModels(usable, parameterized);
    const gpt = merged.find((m) => m.id === "gpt-5.5-high")!;
    expect(gpt.supportsImages).toBe(true);
    expect(gpt.contextWindow).toBe(272_000);
    expect(gpt.requestedModelId).toBe("gpt-5.5-server");
    expect(gpt.parameters).toEqual([{ id: "reasoning", value: "high" }]);
    expect(gpt.requiresMaxMode).toBeUndefined();
  });

  it("marks max-mode variants", () => {
    const parameterized: ParameterizedModel[] = [
      {
        name: "gpt-5.5",
        contextTokenLimit: 272_000,
        contextTokenLimitForMaxMode: 400_000,
        variants: [
          {
            parameters: [{ id: "reasoning", value: "max" }],
            isMaxMode: true,
            variantStringRepresentation: "gpt-5.5-max",
          },
        ],
      },
    ];
    const merged = mergeModels([usable[1]], parameterized);
    // gpt-5.5-max is not in the usable list → appended from metadata.
    const appended = merged.find((m) => m.id === "gpt-5.5-max")!;
    expect(appended).toBeDefined();
    expect(appended.contextWindow).toBe(400_000);
    expect(appended.requiresMaxMode).toBe(true);
    expect(appended.requestedMaxMode).toBe(true);
  });

  it("leaves rows without metadata alone", () => {
    const merged = mergeModels(usable, []);
    const claude = merged.find((m) => m.id === "claude-4.5-opus")!;
    expect(claude.supportsImages).toBeUndefined();
    expect(claude.contextWindow).toBe(200_000);
    expect(claude.requestedModelId).toBeUndefined();
  });

  it("does not duplicate a variant already in the usable list", () => {
    const parameterized: ParameterizedModel[] = [
      {
        name: "gpt-5.5",
        variants: [{ parameters: [], isMaxMode: false, variantStringRepresentation: "gpt-5.5-high" }],
      },
    ];
    const merged = mergeModels(usable, parameterized);
    expect(merged.filter((m) => m.id === "gpt-5.5-high")).toHaveLength(1);
  });

  it("caps gpt-5.6 windows at the prompt limit", () => {
    const merged = mergeModels(
      [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna 1M", contextWindow: 1_000_000, maxTokens: 64_000 }],
      [],
    );
    expect(merged[0].contextWindow).toBe(500_000);
  });
});
