/**
 * Content-addressed blob store for Cursor's KV protocol.
 *
 * Large payloads (system prompt, history messages, turn structures, images) are
 * stored locally and referenced on the wire by their SHA-256 digest. The server
 * pulls them back with `KvServerMessage.get_blob_args`; it may also push blobs
 * to us with `set_blob_args`.
 *
 * One store lives per Run request, so there is no eviction: a client blob that
 * would exceed the cap is refused (throw, never a dangling id) and a server
 * blob that would exceed it is declined.
 */
import { createHash } from "node:crypto";

export const MAX_BLOB_BYTES = 32 * 1024 * 1024;
export const MAX_STORE_BYTES = 256 * 1024 * 1024;

export class BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly maxBlobBytes: number;
  private readonly maxStoreBytes: number;
  bytes = 0;

  constructor(limits?: { maxBlobBytes?: number; maxStoreBytes?: number }) {
    this.maxBlobBytes = limits?.maxBlobBytes ?? MAX_BLOB_BYTES;
    this.maxStoreBytes = limits?.maxStoreBytes ?? MAX_STORE_BYTES;
  }

  /** Store `data` and return its 32-byte SHA-256 blob id. */
  put(data: Uint8Array): Uint8Array {
    const id = new Uint8Array(createHash("sha256").update(data).digest());
    const key = Buffer.from(id).toString("hex");
    if (this.blobs.has(key)) return id;
    if (!this.fits(data.byteLength)) {
      throw new Error(
        `pi-cursor blob store would exceed ${this.maxBlobBytes}/${this.maxStoreBytes} bytes (${data.byteLength}); refusing to send a dangling blob id`,
      );
    }
    this.store(key, data);
    return id;
  }

  /** Look up a blob by its raw id bytes. */
  getByIdBytes(id: Uint8Array): Uint8Array | undefined {
    return this.blobs.get(Buffer.from(id).toString("hex"));
  }

  has(id: Uint8Array): boolean {
    return this.blobs.has(Buffer.from(id).toString("hex"));
  }

  /** Record a blob the server pushed to us. Returns false when it does not fit. */
  setFromServer(id: Uint8Array, data: Uint8Array): boolean {
    const key = Buffer.from(id).toString("hex");
    if (this.blobs.has(key)) return true;
    if (!this.fits(data.byteLength)) return false;
    this.store(key, data);
    return true;
  }

  get entries(): number {
    return this.blobs.size;
  }

  private fits(size: number): boolean {
    return size <= this.maxBlobBytes && this.bytes + size <= this.maxStoreBytes;
  }

  private store(key: string, data: Uint8Array): void {
    this.blobs.set(key, data);
    this.bytes += data.byteLength;
  }
}
