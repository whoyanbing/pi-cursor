/**
 * Hand-rolled wire codec for `aiserver.v1.AiService/AvailableModels`.
 *
 * That RPC predates the generated agent schema, so its request/response are
 * encoded/decoded directly against the wire format. Only the fields Cursor
 * actually reads are handled; unknown fields are skipped.
 */
import type { CursorModelParameter } from "./types.js";

export interface ParameterizedVariant {
  parameters: CursorModelParameter[];
  isMaxMode: boolean;
  isDefaultMaxConfig?: boolean;
  isDefaultNonMaxConfig?: boolean;
  displayName?: string;
  variantStringRepresentation?: string;
}

export interface ParameterizedModel {
  name: string;
  clientDisplayName?: string;
  serverModelName?: string;
  supportsMaxMode?: boolean;
  supportsNonMaxMode?: boolean;
  supportsImages?: boolean;
  contextTokenLimit?: number;
  contextTokenLimitForMaxMode?: number;
  variants: ParameterizedVariant[];
}

function encodeVarint(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function encodeBoolField(fieldNo: number, value: boolean): number[] {
  return [...encodeVarint(fieldNo << 3), value ? 1 : 0];
}

/** AvailableModelsRequest { use_model_parameters = 5; do_not_use_markdown = 7 }. */
export function encodeAvailableModelsRequest(): Uint8Array {
  return new Uint8Array([...encodeBoolField(5, true), ...encodeBoolField(7, true)]);
}

interface Reader {
  bytes: Uint8Array;
  offset: number;
}

function readVarint(reader: Reader): number {
  let result = 0;
  let shift = 0;
  while (reader.offset < reader.bytes.length) {
    const byte = reader.bytes[reader.offset++]!;
    // No bitwise ops: they truncate to 32 bits, and varints we merely skip may
    // legally carry 64-bit values.
    if (shift < 53) result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
    if (shift >= 70) throw new Error("varint too long");
  }
  throw new Error("unexpected EOF while reading varint");
}

function readLengthDelimited(reader: Reader): Uint8Array {
  const length = readVarint(reader);
  if (!Number.isSafeInteger(length)) throw new Error("length-delimited size is too large");
  const end = reader.offset + length;
  if (end > reader.bytes.length) throw new Error("length-delimited field exceeds buffer");
  const value = reader.bytes.subarray(reader.offset, end);
  reader.offset = end;
  return value;
}

function skipField(reader: Reader, wireType: number): void {
  switch (wireType) {
    case 0:
      readVarint(reader);
      return;
    case 1:
      reader.offset += 8;
      return;
    case 2:
      readLengthDelimited(reader);
      return;
    case 5:
      reader.offset += 4;
      return;
    default:
      throw new Error(`unsupported wire type ${wireType}`);
  }
}

function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function decodeParameter(bytes: Uint8Array): CursorModelParameter {
  const reader: Reader = { bytes, offset: 0 };
  const parameter: CursorModelParameter = { id: "", value: "" };
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNo === 1 && wireType === 2) parameter.id = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 2 && wireType === 2) parameter.value = decodeString(readLengthDelimited(reader));
    else skipField(reader, wireType);
  }
  return parameter;
}

function decodeVariant(bytes: Uint8Array): ParameterizedVariant {
  const reader: Reader = { bytes, offset: 0 };
  const variant: ParameterizedVariant = { parameters: [], isMaxMode: false };
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNo === 1 && wireType === 2) variant.parameters.push(decodeParameter(readLengthDelimited(reader)));
    else if (fieldNo === 2 && wireType === 2) variant.displayName = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 3 && wireType === 0) variant.isMaxMode = readVarint(reader) !== 0;
    else if (fieldNo === 4 && wireType === 0) variant.isDefaultMaxConfig = readVarint(reader) !== 0;
    else if (fieldNo === 5 && wireType === 0) variant.isDefaultNonMaxConfig = readVarint(reader) !== 0;
    else if (fieldNo === 8 && wireType === 2) {
      // displayNameOutsidePicker — not needed, skip into the same slot.
      readLengthDelimited(reader);
    } else if (fieldNo === 9 && wireType === 2) {
      variant.variantStringRepresentation = decodeString(readLengthDelimited(reader));
    } else skipField(reader, wireType);
  }
  return variant;
}

function decodeModel(bytes: Uint8Array): ParameterizedModel {
  const reader: Reader = { bytes, offset: 0 };
  const model: ParameterizedModel = { name: "", variants: [] };
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNo === 1 && wireType === 2) model.name = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 10 && wireType === 0) model.supportsImages = readVarint(reader) !== 0;
    else if (fieldNo === 14 && wireType === 0) model.supportsMaxMode = readVarint(reader) !== 0;
    else if (fieldNo === 15 && wireType === 0) model.contextTokenLimit = readVarint(reader);
    else if (fieldNo === 16 && wireType === 0) model.contextTokenLimitForMaxMode = readVarint(reader);
    else if (fieldNo === 17 && wireType === 2) model.clientDisplayName = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 18 && wireType === 2) model.serverModelName = decodeString(readLengthDelimited(reader));
    else if (fieldNo === 19 && wireType === 0) model.supportsNonMaxMode = readVarint(reader) !== 0;
    else if (fieldNo === 30 && wireType === 2) model.variants.push(decodeVariant(readLengthDelimited(reader)));
    else skipField(reader, wireType);
  }
  return model;
}

/** AvailableModelsResponse { repeated ParameterizedModel models = 2 }. */
export function decodeAvailableModelsResponse(bytes: Uint8Array): ParameterizedModel[] {
  const reader: Reader = { bytes, offset: 0 };
  const models: ParameterizedModel[] = [];
  while (reader.offset < bytes.length) {
    const tag = readVarint(reader);
    const fieldNo = Math.floor(tag / 8);
    const wireType = tag % 8;
    if (fieldNo === 2 && wireType === 2) {
      const model = decodeModel(readLengthDelimited(reader));
      if (model.name) models.push(model);
    } else skipField(reader, wireType);
  }
  return models;
}
