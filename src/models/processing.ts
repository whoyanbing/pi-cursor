/**
 * Raw Cursor rows → Pi models.
 *
 * Cursor advertises one row per effort variant (`gpt-5-high`, `gpt-5-xhigh`);
 * Pi wants one model with a thinking-level map. Rows are grouped by
 * (base, fast, thinking); each group collapses into a single Pi model whose
 * thinking levels point at the raw ids, and whose routing (parameters,
 * max-mode) is recorded per raw id in the registry.
 */
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CURSOR_API, PROVIDER_ID, ZERO_COST, getAgentUrl } from "../config.js";
import { clampContextWindow } from "./limits.js";
import { groupedModelId, parseModelId } from "./parse.js";
import { setRouting, type RouteTarget, type RoutingEntry } from "./registry.js";
import type { CursorModel, ProcessedModel } from "./types.js";

const PI_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

interface Group {
  base: string;
  fast: boolean;
  thinking: boolean;
  efforts: Map<string, CursorModel>;
}

function routeTarget(model: CursorModel): RouteTarget {
  return {
    modelId: model.requestedModelId ?? model.id,
    ...(model.requiresMaxMode || model.requestedMaxMode ? { maxMode: true } : {}),
    ...(model.parameters?.length ? { parameters: model.parameters } : {}),
  };
}

export interface ProcessedCatalog {
  models: ProcessedModel[];
  registry: Map<string, RoutingEntry>;
}

export function processModels(raw: readonly CursorModel[]): ProcessedCatalog {
  const groups = new Map<string, Group>();
  for (const model of raw) {
    const parsed = parseModelId(model.id);
    const key = `${parsed.base}|${parsed.fast}|${parsed.thinking}`;
    let group = groups.get(key);
    if (!group) {
      group = { base: parsed.base, fast: parsed.fast, thinking: parsed.thinking, efforts: new Map() };
      groups.set(key, group);
    }
    // First row wins for a given effort (usable-list order is account order).
    if (!group.efforts.has(parsed.effort)) group.efforts.set(parsed.effort, model);
  }

  const models: ProcessedModel[] = [];
  const registry = new Map<string, RoutingEntry>();

  for (const group of groups.values()) {
    const efforts = group.efforts;
    const onlyBare = efforts.size === 1 && efforts.has("");

    if (onlyBare) {
      const model = efforts.get("")!;
      const id = groupedModelId(group.base, group.thinking, group.fast);
      models.push({
        id,
        name: model.name,
        reasoning: group.thinking,
        defaultRawId: model.id,
        supportsImages: model.supportsImages !== false,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        ...(model.aliases ? { aliases: model.aliases } : {}),
      });
      registry.set(id, { defaultRawId: model.id, routes: { [model.id]: routeTarget(model) } });
      continue;
    }

    // Collapse effort variants into one Pi model.
    const representative = efforts.get("medium") ?? efforts.get("") ?? [...efforts.values()][0]!;
    const id = groupedModelId(group.base, group.thinking, group.fast);

    const thinkingLevelMap: Record<string, string | null> = {};
    const noneRow = efforts.get("none");
    thinkingLevelMap.off = noneRow ? noneRow.id : null;
    for (const level of PI_LEVELS) {
      const row = efforts.get(level) ?? (level === "medium" ? efforts.get("") : undefined);
      thinkingLevelMap[level] = row ? row.id : null;
    }

    const defaultRow = efforts.get("medium") ?? efforts.get("") ?? representative;
    const routes: Record<string, RouteTarget> = {};
    for (const model of efforts.values()) routes[model.id] = routeTarget(model);

    models.push({
      id,
      name: representative.name,
      reasoning: true,
      thinkingLevelMap,
      defaultRawId: defaultRow.id,
      supportsImages: representative.supportsImages !== false,
      contextWindow: clampContextWindow(id, representative.name, representative.contextWindow),
      maxTokens: representative.maxTokens,
      ...(representative.aliases ? { aliases: representative.aliases } : {}),
    });
    registry.set(id, { defaultRawId: defaultRow.id, routes });
  }

  models.sort((a, b) => a.id.localeCompare(b.id));
  return { models, registry };
}

/** Process raw rows and publish their routing into the module registry. */
export function processAndRegister(raw: readonly CursorModel[]): ProcessedModel[] {
  const catalog = processModels(raw);
  setRouting(catalog.registry);
  return catalog.models;
}

export function toProviderModels(models: readonly ProcessedModel[]): ProviderModelConfig[] {
  const baseUrl = getAgentUrl();
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    api: CURSOR_API,
    provider: PROVIDER_ID,
    baseUrl,
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.supportsImages ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
    cost: { ...ZERO_COST },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}
