/**
 * Connect RPC binary framing.
 *
 * A frame is: 1 flag byte, 4-byte big-endian payload length, payload.
 * The end-stream flag (0b10) marks the final frame of a stream; on error
 * responses its payload is JSON `{ error: { code, message } }`.
 */
import { CONNECT_END_STREAM_FLAG, MAX_FRAME_BYTES } from "../config.js";

export interface ConnectFrame {
  endStream: boolean;
  payload: Uint8Array;
}

/** Zero-copy Buffer view over a Uint8Array (Buffer.from(u8) would copy). */
export function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function encodeFrame(payload: Uint8Array, endStream = false): Buffer {
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame[0] = endStream ? CONNECT_END_STREAM_FLAG : 0;
  frame.writeUInt32BE(payload.byteLength, 1);
  frame.set(payload, 5);
  return frame;
}

export interface ConnectErrorPayload {
  code?: string;
  message?: string;
}

export function parseErrorPayload(payload: Uint8Array): ConnectErrorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(payload).toString("utf8")) as {
      error?: ConnectErrorPayload;
    };
    return parsed?.error ?? {};
  } catch {
    return { message: Buffer.from(payload).toString("utf8").slice(0, 500) };
  }
}

/**
 * Incremental frame parser. Feed raw transport chunks; receive complete frames.
 * Buffers chunks in a list and only concatenates when a full frame is available,
 * keeping large frames split across many reads O(n) instead of O(n²).
 */
export class FrameParser {
  private chunks: Buffer[] = [];
  private buffered = 0;
  private header: { endStream: boolean; length: number } | null = null;

  push(chunk: Uint8Array): ConnectFrame[] {
    const buf = asBuffer(chunk);
    this.chunks.push(buf);
    this.buffered += buf.byteLength;

    const frames: ConnectFrame[] = [];
    for (;;) {
      if (!this.header) {
        if (this.buffered < 5) break;
        const head = this.take(5);
        const flags = head[0];
        const length = head.readUInt32BE(1);
        if (length > MAX_FRAME_BYTES) {
          throw new Error(`Connect frame too large: ${length} bytes`);
        }
        this.header = { endStream: (flags & CONNECT_END_STREAM_FLAG) !== 0, length };
      }
      if (this.buffered < this.header.length) break;
      const payload = this.header.length > 0 ? this.take(this.header.length) : new Uint8Array(0);
      frames.push({ endStream: this.header.endStream, payload });
      this.header = null;
    }
    return frames;
  }

  private take(count: number): Buffer {
    if (this.chunks.length === 1 && this.chunks[0].byteLength === count) {
      this.buffered = 0;
      return this.chunks.shift()!;
    }
    const out = Buffer.allocUnsafe(count);
    let offset = 0;
    while (offset < count) {
      const head = this.chunks[0];
      const copy = Math.min(head.byteLength, count - offset);
      head.copy(out, offset, 0, copy);
      offset += copy;
      if (copy === head.byteLength) this.chunks.shift();
      else this.chunks[0] = head.subarray(copy);
    }
    this.buffered -= count;
    return out;
  }
}
