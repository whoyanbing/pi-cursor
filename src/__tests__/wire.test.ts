import { describe, expect, it } from "vitest";
import {
  decodeAvailableModelsResponse,
  encodeAvailableModelsRequest,
  type ParameterizedModel,
} from "../models/wire.js";
import { mergeModels, unwrapUnaryBody } from "../models/discovery.js";
import type { CursorModel } from "../models/types.js";

function varint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function field(fieldNo: number, wireType: number, payload: number[] | Uint8Array): number[] {
  const tag = (fieldNo << 3) | wireType;
  if (wireType === 0) return [...varint(tag), ...(payload as number[])];
  const bytes = payload as Uint8Array;
  return [...varint(tag), ...varint(bytes.length), ...bytes];
}

function str(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** Build a ParameterizedModel wire image from a friendly description. */
function encodeModel(model: {
  name: string;
  serverModelName?: string;
  clientDisplayName?: string;
  supportsImages?: boolean;
  contextTokenLimit?: number;
  contextTokenLimitForMaxMode?: number;
  variants?: Array<{ representation?: string; displayName?: string; isMaxMode?: boolean; parameters?: Array<[string, string]> }>;
}): Uint8Array {
  const parts: number[] = [];
  parts.push(...field(1, 2, str(model.name)));
  if (model.supportsImages !== undefined) parts.push(...field(10, 0, varint(model.supportsImages ? 1 : 0)));
  if (model.contextTokenLimit !== undefined) parts.push(...field(15, 0, varint(model.contextTokenLimit)));
  if (model.contextTokenLimitForMaxMode !== undefined) {
    parts.push(...field(16, 0, varint(model.contextTokenLimitForMaxMode)));
  }
  if (model.clientDisplayName) parts.push(...field(17, 2, str(model.clientDisplayName)));
  if (model.serverModelName) parts.push(...field(18, 2, str(model.serverModelName)));
  for (const variant of model.variants ?? []) {
    const vparts: number[] = [];
    for (const [id, value] of variant.parameters ?? []) {
      const pparts = [...field(1, 2, str(id)), ...field(2, 2, str(value))];
      vparts.push(...field(1, 2, new Uint8Array(pparts)));
    }
    if (variant.displayName) vparts.push(...field(2, 2, str(variant.displayName)));
    if (variant.isMaxMode) vparts.push(...field(3, 0, varint(1)));
    if (variant.representation) vparts.push(...field(9, 2, str(variant.representation)));
    parts.push(...field(30, 2, new Uint8Array(vparts)));
  }
  return new Uint8Array(parts);
}

function encodeResponse(models: Uint8Array[]): Uint8Array {
  const parts: number[] = [];
  for (const model of models) parts.push(...field(2, 2, model));
  return new Uint8Array(parts);
}

describe("encodeAvailableModelsRequest", () => {
  it("sets use_model_parameters (5) and do_not_use_markdown (7)", () => {
    const bytes = encodeAvailableModelsRequest();
    // field 5 varint → tag (5<<3)|0 = 40 = 0x28, value 1
    // field 7 varint → tag (7<<3)|0 = 56 = 0x38, value 1
    expect(Array.from(bytes)).toEqual([0x28, 1, 0x38, 1]);
  });
});

describe("decodeAvailableModelsResponse", () => {
  it("decodes model metadata and variants", () => {
    const wire = encodeResponse([
      encodeModel({
        name: "gpt-5.5",
        serverModelName: "gpt-5.5-server",
        clientDisplayName: "GPT-5.5",
        supportsImages: true,
        contextTokenLimit: 272_000,
        contextTokenLimitForMaxMode: 400_000,
        variants: [
          { representation: "gpt-5.5-high", displayName: "High", parameters: [["reasoning", "high"]] },
          { representation: "gpt-5.5-max", displayName: "Max", isMaxMode: true, parameters: [["reasoning", "max"]] },
        ],
      }),
    ]);
    const models = decodeAvailableModelsResponse(wire);
    expect(models).toHaveLength(1);
    const model = models[0];
    expect(model.name).toBe("gpt-5.5");
    expect(model.serverModelName).toBe("gpt-5.5-server");
    expect(model.clientDisplayName).toBe("GPT-5.5");
    expect(model.supportsImages).toBe(true);
    expect(model.contextTokenLimit).toBe(272_000);
    expect(model.contextTokenLimitForMaxMode).toBe(400_000);
    expect(model.variants).toHaveLength(2);
    expect(model.variants[0]).toMatchObject({
      variantStringRepresentation: "gpt-5.5-high",
      isMaxMode: false,
      parameters: [{ id: "reasoning", value: "high" }],
    });
    expect(model.variants[1]).toMatchObject({ variantStringRepresentation: "gpt-5.5-max", isMaxMode: true });
  });

  it("skips unknown fields", () => {
    const model = encodeModel({ name: "m" });
    // Append an unknown length-delimited field 99 and an unknown varint field 98.
    const withUnknown = new Uint8Array([
      ...model,
      ...field(99, 2, str("ignored")),
      ...field(98, 0, varint(7)),
    ]);
    const models = decodeAvailableModelsResponse(encodeResponse([withUnknown]));
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("m");
  });

  it("drops nameless models", () => {
    const models = decodeAvailableModelsResponse(encodeResponse([encodeModel({ name: "" })]));
    expect(models).toHaveLength(0);
  });

  it("returns empty for an empty response", () => {
    expect(decodeAvailableModelsResponse(new Uint8Array())).toEqual([]);
  });
});

describe("unwrapUnaryBody", () => {
  it("passes plain protobuf through", () => {
    const plain = new Uint8Array([0x0a, 0x02, 0x41, 0x42]);
    expect(unwrapUnaryBody(plain)).toBe(plain);
  });

  it("unwraps a single connect frame", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = new Uint8Array([0, 0, 0, 0, 3, 1, 2, 3]);
    expect(Array.from(unwrapUnaryBody(frame))).toEqual(Array.from(payload));
  });

  it("leaves short payloads alone", () => {
    const short = new Uint8Array([1, 2]);
    expect(unwrapUnaryBody(short)).toBe(short);
  });
});

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
