/**
 * Startup model catalog: bundled seeds + on-disk discovery cache.
 *
 * Pi registers models synchronously at activation, so the catalog must be
 * available without network access. Bundled seeds cover the common lineup;
 * the cache (written by discovery) overrides them until it goes stale.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { MODEL_CACHE_FILE, MODEL_CACHE_TTL_MS } from "../config.js";
import { inferContextWindow, inferMaxOutputTokens } from "./limits.js";
import type { CatalogSeed, CursorModel } from "./types.js";
import seeds from "./catalog.json";

export function seedModels(): CursorModel[] {
  // `reasoning` in catalog.json is documentation only; grouping infers it from id suffixes.
  return (seeds as CatalogSeed[]).map((seed) => ({
    id: seed.id,
    name: seed.name || seed.id,
    contextWindow: seed.contextWindow ?? inferContextWindow(seed.id, seed.name ?? ""),
    maxTokens: seed.maxTokens ?? inferMaxOutputTokens(seed.id, seed.name ?? ""),
    ...(seed.requestedModelId ? { requestedModelId: seed.requestedModelId } : {}),
  }));
}

interface CacheFile {
  savedAt?: number;
  models?: CursorModel[];
}

export function cachePath(): string {
  return join(homedir(), ".pi", "agent", MODEL_CACHE_FILE);
}

function readCache(): CacheFile | null {
  try {
    if (!existsSync(cachePath())) return null;
    return JSON.parse(readFileSync(cachePath(), "utf8")) as CacheFile;
  } catch {
    return null;
  }
}

export function writeCache(models: readonly CursorModel[]): void {
  try {
    const file = cachePath();
    const dir = dirname(file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const payload: CacheFile = { savedAt: Date.now(), models: [...models] };
    writeFileSync(file, JSON.stringify(payload), "utf8");
  } catch (error) {
    console.error("[pi-cursor] Failed to write model cache:", error);
  }
}

export function cacheInfo(): { savedAt: number | null; count: number; stale: boolean } {
  const data = readCache();
  const savedAt = typeof data?.savedAt === "number" ? data.savedAt : null;
  const count = data && Array.isArray(data.models) ? data.models.length : 0;
  const stale = savedAt === null || Date.now() - savedAt > MODEL_CACHE_TTL_MS;
  return { savedAt, count, stale };
}

/** Fresh cached rows, or null when missing/stale. */
export function cachedModels(): CursorModel[] | null {
  const data = readCache();
  if (data && Array.isArray(data.models) && data.models.length > 0) {
    if (typeof data.savedAt === "number" && Date.now() - data.savedAt <= MODEL_CACHE_TTL_MS) {
      return data.models;
    }
  }
  return null;
}

/** Rows to register at startup: cache when fresh, bundled seeds otherwise. */
export function startupCatalog(): CursorModel[] {
  return cachedModels() ?? seedModels();
}
