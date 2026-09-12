/**
 * Model shapes shared across discovery, processing, and the routing registry.
 */
import type {
  ParameterizedModel as WireModel,
  ParameterizedVariant as WireVariant,
} from "../proto/aiserver_pb.js";

export interface CursorModelParameter {
  id: string;
  value: string;
}

/** `AvailableModels` rows without protobuf `$typeName`, so plain literals type-check. */
export type ParameterizedVariant = Omit<WireVariant, "$typeName" | "parameters"> & {
  parameters: CursorModelParameter[];
};
export type ParameterizedModel = Omit<WireModel, "$typeName" | "variants"> & {
  variants: ParameterizedVariant[];
};

/** A raw model row exactly as Cursor advertises it (id carries effort suffixes). */
export interface CursorModel {
  id: string;
  name: string;
  supportsImages?: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Parameterized variants route through requestedModel + parameters. */
  requestedModelId?: string;
  parameters?: CursorModelParameter[];
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
  aliases?: string[];
}

/** A Pi-facing model: effort variants collapsed into one id + thinking map. */
export interface ProcessedModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** Pi thinking level → raw Cursor model id (null = level unsupported). */
  thinkingLevelMap?: Record<string, string | null>;
  /** Raw id used when no reasoning level is requested. */
  defaultRawId: string;
  supportsImages: boolean;
  contextWindow: number;
  maxTokens: number;
  aliases?: string[];
}

/** Seed entry shape from the bundled catalog.json. */
export interface CatalogSeed {
  id: string;
  name: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  /** Wire id when it differs from the Pi-facing id (e.g. `auto` -> `default`). */
  requestedModelId?: string;
}
