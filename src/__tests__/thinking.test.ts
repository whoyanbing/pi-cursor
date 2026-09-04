import { describe, expect, it } from "vitest";
import { stripThinkingTags, ThinkingTagParser } from "../protocol/thinking.js";

describe("ThinkingTagParser", () => {
  it("passes plain text through", () => {
    const parser = new ThinkingTagParser();
    expect(parser.process("hello ")).toEqual({ content: "hello ", reasoning: "" });
    expect(parser.process("world")).toEqual({ content: "world", reasoning: "" });
    expect(parser.flush()).toEqual({ content: "", reasoning: "" });
  });

  it("routes tagged reasoning to the reasoning channel", () => {
    const parser = new ThinkingTagParser();
    const first = parser.process("<thinking>step one</thinking>answer");
    expect(first.reasoning).toBe("step one");
    expect(first.content).toBe("answer");
  });

  it("handles tags split across chunks", () => {
    const parser = new ThinkingTagParser();
    const a = parser.process("before<thi");
    const b = parser.process("nking>inside");
    const c = parser.process("</thinking>after");
    expect(a.content).toBe("before");
    expect(b.reasoning).toBe("inside");
    expect(c.reasoning).toBe("");
    expect(c.content).toBe("after");
  });

  it("supports reasoning/thought tag names", () => {
    const parser = new ThinkingTagParser();
    const split = parser.process("<reasoning>why</reasoning><thought>hmm</thought>done");
    expect(split.reasoning).toBe("whyhmm");
    expect(split.content).toBe("done");
  });

  it("flushes an unclosed tail as content", () => {
    const parser = new ThinkingTagParser();
    parser.process("text<th");
    const flushed = parser.flush();
    expect(flushed.content).toBe("<th");
  });

  it("emits reasoning right after an open tag", () => {
    const parser = new ThinkingTagParser();
    expect(parser.process("<thinking>partial")).toEqual({ content: "", reasoning: "partial" });
  });

  it("flushes a held-back tail as reasoning when inside a tag", () => {
    const parser = new ThinkingTagParser();
    expect(parser.process("<thinking>partial<").reasoning).toBe("partial");
    const flushed = parser.flush();
    expect(flushed.reasoning).toBe("<");
    expect(flushed.content).toBe("");
  });

  it("stripThinkingTags removes tagged spans", () => {
    expect(stripThinkingTags("<thinking>hidden</thinking>visible")).toBe("visible");
  });

  it("emits less-than signs that are not tags", () => {
    const parser = new ThinkingTagParser();
    const a = parser.process("a < b and <notatag");
    const b = parser.process("> done");
    expect(a.content + b.content + parser.flush().content).toBe("a < b and <notatag> done");
  });
});
