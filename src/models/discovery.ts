/**
 * Live model discovery over Connect unary RPCs.
 *
 * `GetUsableModels` is authoritative for what the account may request;
 * `AvailableModels` adds parameterized metadata (image support, context limits,
 * per-variant request parameters/max-mode) matched onto usable rows by the
 * variant's string representation.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
  type ModelDetails,
} from "../proto/agent_pb.js";
import { AVAILABLE_MODELS_RPC, USABLE_MODELS_RPC, getAgentUrl } from "../config.js";
import { unaryRpc } from "../transport/h2.js";
import { clampContextWindow, inferContextWindow, inferMaxOutputTokens } from "./limits.js";
import type { CursorModel } from "./types.js";
import { decodeAvailableModelsResponse, encodeAvailableModelsRequest, type ParameterizedModel } from "./wire.js";

/** Unary bodies arrive as plain protobuf or as one Connect frame; accept both. */
export function unwrapUnaryBody(payload: Uint8Array): Uint8Array {
  if (payload.length < 5) return payload;
  const flags = payload[0];
  const length = new DataView(payload.buffer, payload.byteOffset + 1, 4).getUint32(0, false);
  // A plausible frame: known flags, length covering the rest of the buffer.
  if ((flags & ~0b11) === 0 && 5 + length === payload.length) {
    return payload.subarray(5, 5 + length);
  }
  return payload;
}

/** Decode plain protobuf first; fall back to unwrapping a Connect frame. */
function decodeUnary<T>(payload: Uint8Array, decode: (bytes: Uint8Array) => T): T {
  try {
    return decode(payload);
  } catch {
    return decode(unwrapUnaryBody(payload));
  }
}

function normalizeUsable(models: readonly ModelDetails[]): CursorModel[] {
  const rows: CursorModel[] = [];
  for (const details of models) {
    let id = details.modelId?.trim();
    if (!id) continue;
    let requestedModelId: string | undefined;
    if (id === "default") {
      requestedModelId = "default";
      id = "auto";
    }
    const name = details.displayName?.trim() || details.displayModelId?.trim() || id;
    rows.push({
      id,
      name,
      contextWindow: inferContextWindow(id, name),
      maxTokens: inferMaxOutputTokens(id, name),
      ...(requestedModelId ? { requestedModelId } : {}),
      ...(details.aliases?.length ? { aliases: [...details.aliases] } : {}),
    });
  }
  return rows;
}

export async function fetchUsableModels(token: string, signal?: AbortSignal): Promise<CursorModel[]> {
  const body = toBinary(GetUsableModelsRequestSchema, create(GetUsableModelsRequestSchema, {}));
  const response = await unaryRpc(getAgentUrl(), { rpcPath: USABLE_MODELS_RPC, token, body, signal });
  const payload = new Uint8Array(response);
  const decoded = decodeUnary(payload, (bytes) => fromBinary(GetUsableModelsResponseSchema, bytes));
  return normalizeUsable(decoded.models ?? []);
}

export async function fetchParameterizedModels(token: string, signal?: AbortSignal): Promise<ParameterizedModel[]> {
  const response = await unaryRpc(getAgentUrl(), {
    rpcPath: AVAILABLE_MODELS_RPC,
    token,
    body: encodeAvailableModelsRequest(),
    signal,
  });
  const payload = new Uint8Array(response);
  return decodeUnary(payload, (bytes) => decodeAvailableModelsResponse(bytes));
}

/**
 * Merge parameterized metadata onto usable rows:
 *   - `supportsImages` / context limits by model name
 *   - request parameters / max-mode by variant string representation
 * Variants absent from the usable list are appended so newer models still show
 * up before Cursor adds them to the account picker.
 */
export function mergeModels(usable: CursorModel[], parameterized: ParameterizedModel[]): CursorModel[] {
  const metaByName = new Map<string, ParameterizedModel>();
  for (const model of parameterized) {
    if (model.name) metaByName.set(model.name.toLowerCase(), model);
    if (model.serverModelName) metaByName.set(model.serverModelName.toLowerCase(), model);
  }

  const variantByRep = new Map<string, { model: ParameterizedModel; variantIndex: number }>();
  for (const model of parameterized) {
    model.variants.forEach((variant, index) => {
      const rep = variant.variantStringRepresentation?.trim();
      if (rep) variantByRep.set(rep.toLowerCase(), { model, variantIndex: index });
    });
  }

  const merged: CursorModel[] = [];
  const seen = new Set<string>();
  for (const row of usable) {
    seen.add(row.id.toLowerCase());
    const meta = metaByName.get(row.id.toLowerCase()) ?? metaByName.get(row.requestedModelId?.toLowerCase() ?? "");
    const variantHit = variantByRep.get(row.id.toLowerCase());
    const variant = variantHit ? variantHit.model.variants[variantHit.variantIndex] : undefined;
    const variantModel = variantHit?.model;

    let contextWindow = row.contextWindow;
    if (variantModel) {
      const advertised = variant?.isMaxMode
        ? variantModel.contextTokenLimitForMaxMode ?? variantModel.contextTokenLimit
        : variantModel.contextTokenLimit;
      if (advertised && advertised > 0) contextWindow = advertised;
    } else if (meta?.contextTokenLimit && meta.contextTokenLimit > 0) {
      contextWindow = meta.contextTokenLimit;
    }

    merged.push({
      ...row,
      supportsImages: row.supportsImages ?? variantModel?.supportsImages ?? meta?.supportsImages,
      contextWindow: clampContextWindow(row.id, row.name, contextWindow),
      ...(variant && variantModel
        ? {
            requestedModelId: variantModel.serverModelName || variantModel.name,
            parameters: variant.parameters,
            ...(variant.isMaxMode ? { requiresMaxMode: true, requestedMaxMode: true } : {}),
          }
        : {}),
    });
  }

  // Parameterized-only variants: expose them under their string representation.
  for (const [rep, hit] of variantByRep) {
    if (seen.has(rep)) continue;
    const variant = hit.model.variants[hit.variantIndex];
    if (!variant) continue;
    const id = variant.variantStringRepresentation!;
    const name = variant.displayName || hit.model.clientDisplayName || id;
    const contextWindow = variant.isMaxMode
      ? hit.model.contextTokenLimitForMaxMode ?? hit.model.contextTokenLimit ?? inferContextWindow(id, name)
      : hit.model.contextTokenLimit ?? inferContextWindow(id, name);
    merged.push({
      id,
      name,
      supportsImages: hit.model.supportsImages,
      contextWindow: clampContextWindow(id, name, contextWindow),
      maxTokens: inferMaxOutputTokens(id, name),
      requestedModelId: hit.model.serverModelName || hit.model.name,
      parameters: variant.parameters,
      ...(variant.isMaxMode ? { requiresMaxMode: true, requestedMaxMode: true } : {}),
    });
    seen.add(rep);
  }

  return merged;
}

/** Discover the account's raw model rows; parameterized metadata is best-effort. */
export async function discoverModels(token: string, signal?: AbortSignal): Promise<CursorModel[]> {
  const usable = await fetchUsableModels(token, signal);
  if (usable.length === 0) return [];
  try {
    const parameterized = await fetchParameterizedModels(token, signal);
    return mergeModels(usable, parameterized);
  } catch {
    return usable;
  }
}
