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
  /** Client-put ids that the current Run request still references. Never evict these. */
  private readonly pinned = new Set<string>();
  private readonly maxBlobBytes: number;
  private readonly maxStoreBytes: number;
  private readonly maxStoreEntries: number;

  constructor(limits?: { maxBlobBytes?: number; maxStoreBytes?: number; maxStoreEntries?: number }) {
    this.maxBlobBytes = limits?.maxBlobBytes ?? MAX_BLOB_BYTES;
    this.maxStoreBytes = limits?.maxStoreBytes ?? MAX_STORE_BYTES;
    this.maxStoreEntries = limits?.maxStoreEntries ?? MAX_STORE_ENTRIES;
  }

  /** Store `data` and return its 32-byte SHA-256 blob id. */
  put(data: Uint8Array): Uint8Array {
    if (data.byteLength > this.maxBlobBytes) {
      throw new Error(
        `pi-cursor blob exceeds ${this.maxBlobBytes} bytes (${data.byteLength}); refusing to send a dangling blob id`,
      );
    }
    const id = new Uint8Array(createHash("sha256").update(data).digest());
    const key = Buffer.from(id).toString("hex");
    this.pinned.add(key);
    if (!this.blobs.has(key)) {
      this.blobs.set(key, data);
      this.order.push(key);
      this.totalBytes += data.byteLength;
      this.evict();
      if (this.totalBytes > this.maxStoreBytes || this.order.length > this.maxStoreEntries) {
        this.blobs.delete(key);
        this.pinned.delete(key);
        const index = this.order.lastIndexOf(key);
        if (index >= 0) this.order.splice(index, 1);
        this.totalBytes -= data.byteLength;
        throw new Error(
          `pi-cursor blob store would exceed ${this.maxStoreBytes} bytes / ${this.maxStoreEntries} entries; refusing to send a dangling blob id`,
        );
      }
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
    if (data.byteLength > this.maxBlobBytes) return false;
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
    while (this.totalBytes > this.maxStoreBytes || this.order.length > this.maxStoreEntries) {
      const index = this.order.findIndex((key) => !this.pinned.has(key));
      if (index < 0) break;
      const key = this.order.splice(index, 1)[0];
      const blob = this.blobs.get(key);
      if (blob) {
        this.totalBytes -= blob.byteLength;
        this.blobs.delete(key);
      }
    }
  }
}
