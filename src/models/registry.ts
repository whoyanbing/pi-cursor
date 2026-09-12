/**
 * Routing registry: Pi model id → how to address it on Cursor's wire.
 *
 * Filled at startup from the bundled catalog / disk cache and refreshed by
 * model discovery. `streamCursor` resolves the raw id for the requested
 * thinking level here, along with any parameterized-variant routing.
 */
import type { CursorModelParameter } from "./types.js";

export interface RouteTarget {
  /** Raw model id Cursor expects in `requestedModel.modelId`. */
  modelId: string;
  maxMode?: boolean;
  parameters?: CursorModelParameter[];
}

export interface RoutingEntry {
  /** Raw id used when Pi requests no thinking level. */
  defaultRawId: string;
  /** Raw id → wire routing. */
  routes: Record<string, RouteTarget>;
}

const registry = new Map<string, RoutingEntry>();

export function setRouting(entries: Map<string, RoutingEntry>): void {
  registry.clear();
  for (const [id, entry] of entries) registry.set(id, entry);
}

export function lookupRouting(modelId: string): RoutingEntry | undefined {
  return registry.get(modelId);
}

/** Resolve the wire target for a Pi model id + thinking level (map value = raw id). */
export function resolveRouteTarget(modelId: string, levelRawId: string | undefined): RouteTarget {
  const entry = registry.get(modelId);
  const rawId = levelRawId ?? entry?.defaultRawId ?? modelId;
  return entry?.routes[rawId] ?? { modelId: rawId };
}

export function registrySize(): number {
  return registry.size;
}

export function clearRouting(): void {
  registry.clear();
}
