/**
 * Content-addressed blob store for Cursor's KV protocol.
 *
 * Large payloads (system prompt, history messages, turn structures, images) are
 * stored locally and referenced on the wire by their SHA-256 digest. The server
 * pulls them back with `KvServerMessage.get_blob_args`; it may also push blobs
 * to us with `set_blob_args`.
 */
import { createHash } from "node:crypto";

export const MAX_BLOB_BYTES = 32 * 1024 * 1024;
export const MAX_STORE_BYTES = 256 * 1024 * 1024;
export const MAX_STORE_ENTRIES = 5000;

export class BlobStore {
  private readonly blobs = new Map<string, Uint8Array>();
  private totalBytes = 0;
  /** Insertion-ordered keys, oldest first, for eviction. */
  private readonly order: string[] = [];
  droppedCount = 0;
  droppedBytes = 0;

  /** Store `data` and return its 32-byte SHA-256 blob id. */
  put(data: Uint8Array): Uint8Array {
    const id = new Uint8Array(createHash("sha256").update(data).digest());
    const key = Buffer.from(id).toString("hex");
    if (!this.blobs.has(key)) {
      if (data.byteLength > MAX_BLOB_BYTES) {
        this.droppedCount += 1;
        this.droppedBytes += data.byteLength;
        return id;
      }
      this.blobs.set(key, data);
      this.order.push(key);
      this.totalBytes += data.byteLength;
      this.evict();
    }
    return id;
  }

  /** Look up a blob by its raw id bytes. */
  getByIdBytes(id: Uint8Array): Uint8Array | undefined {
    return this.blobs.get(Buffer.from(id).toString("hex"));
  }

  has(id: Uint8Array): boolean {
    return this.blobs.has(Buffer.from(id).toString("hex"));
  }

  /** Record a blob the server pushed to us. Returns false when oversized. */
  setFromServer(id: Uint8Array, data: Uint8Array): boolean {
    if (data.byteLength > MAX_BLOB_BYTES) {
      this.droppedCount += 1;
      this.droppedBytes += data.byteLength;
      return false;
    }
    const key = Buffer.from(id).toString("hex");
    if (!this.blobs.has(key)) {
      this.blobs.set(key, data);
      this.order.push(key);
      this.totalBytes += data.byteLength;
      this.evict();
    }
    return true;
  }

  get entries(): number {
    return this.blobs.size;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  private evict(): void {
    while (
      (this.totalBytes > MAX_STORE_BYTES || this.order.length > MAX_STORE_ENTRIES) &&
      this.order.length > 1
    ) {
      const key = this.order.shift()!;
      const blob = this.blobs.get(key);
      if (blob) {
        this.totalBytes -= blob.byteLength;
        this.blobs.delete(key);
        this.droppedCount += 1;
        this.droppedBytes += blob.byteLength;
      }
    }
  }
}
