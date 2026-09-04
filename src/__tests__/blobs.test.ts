import { describe, expect, it } from "vitest";
import { BlobStore, MAX_BLOB_BYTES, MAX_STORE_ENTRIES } from "../protocol/blobs.js";

describe("BlobStore", () => {
  it("addresses content by sha256", () => {
    const store = new BlobStore();
    const data = new TextEncoder().encode("payload");
    const id = store.put(data);
    expect(id).toHaveLength(32);
    expect(store.getByIdBytes(id)).toEqual(data);
    expect(store.has(id)).toBe(true);
  });

  it("dedupes identical content", () => {
    const store = new BlobStore();
    const data = new TextEncoder().encode("same");
    const a = store.put(data);
    const b = store.put(data);
    expect(Buffer.from(a).toString("hex")).toBe(Buffer.from(b).toString("hex"));
    expect(store.entries).toBe(1);
  });

  it("accepts server-pushed blobs", () => {
    const store = new BlobStore();
    const id = new Uint8Array(32).fill(1);
    expect(store.setFromServer(id, new Uint8Array([5]))).toBe(true);
    expect(store.getByIdBytes(id)).toEqual(new Uint8Array([5]));
  });

  it("returns unknown ids as undefined", () => {
    const store = new BlobStore();
    expect(store.getByIdBytes(new Uint8Array(32))).toBeUndefined();
  });

  it("tracks byte totals", () => {
    const store = new BlobStore();
    store.put(new Uint8Array(10));
    store.put(new Uint8Array(20));
    expect(store.bytes).toBe(30);
    expect(store.entries).toBe(2);
  });

  it("throws instead of returning a dangling id for oversized blobs", () => {
    const store = new BlobStore();
    expect(() => store.put(new Uint8Array(MAX_BLOB_BYTES + 1))).toThrow(/dangling blob id/);
    expect(store.entries).toBe(0);
  });

  it("refuses oversized server-pushed blobs", () => {
    const store = new BlobStore();
    const id = new Uint8Array(32).fill(7);
    expect(store.setFromServer(id, new Uint8Array(MAX_BLOB_BYTES + 1))).toBe(false);
    expect(store.has(id)).toBe(false);
  });

  it("never evicts client-put blobs when the store overflows", () => {
    const store = new BlobStore();
    const keep = store.put(new TextEncoder().encode("keep-me"));
    for (let i = 0; i < MAX_STORE_ENTRIES + 1; i += 1) {
      const id = new Uint8Array(32);
      new DataView(id.buffer).setUint32(0, i);
      store.setFromServer(id, new Uint8Array([i & 0xff]));
    }
    expect(store.has(keep)).toBe(true);
    expect(store.getByIdBytes(keep)).toEqual(new TextEncoder().encode("keep-me"));
    expect(store.entries).toBeLessThanOrEqual(MAX_STORE_ENTRIES);
  });
});
