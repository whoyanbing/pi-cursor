import { describe, expect, it } from "vitest";
import { encodeErrorFrame, encodeFrame, FrameParser, parseErrorPayload } from "../transport/connect.js";

describe("connect framing", () => {
  it("round-trips a frame", () => {
    const payload = new TextEncoder().encode("hello world");
    const frames = new FrameParser().push(encodeFrame(payload));
    expect(frames).toHaveLength(1);
    expect(frames[0].endStream).toBe(false);
    expect(new TextDecoder().decode(frames[0].payload)).toBe("hello world");
  });

  it("writes flag byte and big-endian length", () => {
    const frame = Buffer.from(encodeFrame(new Uint8Array([1, 2, 3])));
    expect(frame[0]).toBe(0);
    expect(frame.readUInt32BE(1)).toBe(3);
    expect(Array.from(frame.subarray(5))).toEqual([1, 2, 3]);
  });

  it("marks end-stream frames", () => {
    const frames = new FrameParser().push(encodeFrame(new Uint8Array([9]), true));
    expect(frames[0].endStream).toBe(true);
  });

  it("reassembles a frame split across chunks", () => {
    const payload = new Uint8Array(300).fill(7);
    const wire = encodeFrame(payload);
    const parser = new FrameParser();
    expect(parser.push(wire.subarray(0, 3))).toHaveLength(0);
    expect(parser.push(wire.subarray(3, 100))).toHaveLength(0);
    const frames = parser.push(wire.subarray(100));
    expect(frames).toHaveLength(1);
    expect(Array.from(frames[0].payload)).toEqual(Array.from(payload));
  });

  it("splits two frames arriving in one chunk", () => {
    const a = encodeFrame(new TextEncoder().encode("one"));
    const b = encodeFrame(new TextEncoder().encode("two"), true);
    const combined = Buffer.concat([Buffer.from(a), Buffer.from(b)]);
    const frames = new FrameParser().push(combined);
    expect(frames).toHaveLength(2);
    expect(new TextDecoder().decode(frames[0].payload)).toBe("one");
    expect(frames[1].endStream).toBe(true);
    expect(new TextDecoder().decode(frames[1].payload)).toBe("two");
  });

  it("parses error payloads", () => {
    const frame = encodeErrorFrame("unavailable", "goaway");
    const parsed = new FrameParser().push(frame)[0];
    expect(parsed.endStream).toBe(true);
    const error = parseErrorPayload(parsed.payload);
    expect(error.code).toBe("unavailable");
    expect(error.message).toBe("goaway");
  });

  it("parseErrorPayload tolerates non-JSON payloads", () => {
    const error = parseErrorPayload(new TextEncoder().encode("not json"));
    expect(error.message).toBe("not json");
  });

  it("rejects absurd frame lengths", () => {
    const parser = new FrameParser();
    const header = Buffer.alloc(5);
    header[0] = 0;
    header.writeUInt32BE(0xffffffff, 1);
    expect(() => parser.push(header)).toThrow(/too large/);
  });
});
