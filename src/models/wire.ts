/**
 * Codec for `aiserver.v1.AiService/AvailableModels` (schema in proto/aiserver.proto).
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AvailableModelsRequestSchema,
  AvailableModelsResponseSchema,
  type ParameterizedModel as WireModel,
  type ParameterizedVariant as WireVariant,
} from "../proto/aiserver_pb.js";

/** Plain shapes (no `$typeName`) so callers and tests can build literals. */
export type ParameterizedVariant = Omit<WireVariant, "$typeName" | "parameters"> & {
  parameters: Array<{ id: string; value: string }>;
};
export type ParameterizedModel = Omit<WireModel, "$typeName" | "variants"> & {
  variants: ParameterizedVariant[];
};

export function encodeAvailableModelsRequest(): Uint8Array {
  return toBinary(
    AvailableModelsRequestSchema,
    create(AvailableModelsRequestSchema, { useModelParameters: true, doNotUseMarkdown: true }),
  );
}

export function decodeAvailableModelsResponse(bytes: Uint8Array): ParameterizedModel[] {
  return fromBinary(AvailableModelsResponseSchema, bytes).models.filter((model) => model.name);
}
