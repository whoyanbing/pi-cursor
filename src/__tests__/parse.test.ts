import { describe, expect, it } from "vitest";
import { groupedModelId, parseModelId } from "../models/parse.js";

describe("parseModelId", () => {
  it("splits effort suffixes", () => {
    expect(parseModelId("claude-4.5-opus-high")).toMatchObject({ base: "claude-4.5-opus", effort: "high", fast: false, thinking: false });
    expect(parseModelId("gpt-5-xhigh")).toMatchObject({ base: "gpt-5", effort: "xhigh" });
    expect(parseModelId("gpt-5-extra-high")).toMatchObject({ base: "gpt-5", effort: "xhigh" });
    expect(parseModelId("gpt-5.5-none")).toMatchObject({ base: "gpt-5.5", effort: "none" });
    expect(parseModelId("gpt-5.5-minimal")).toMatchObject({ base: "gpt-5.5", effort: "minimal" });
  });

  it("detects -fast", () => {
    expect(parseModelId("composer-fast")).toMatchObject({ base: "composer", fast: true });
    expect(parseModelId("gpt-5-high-fast")).toMatchObject({ base: "gpt-5", effort: "high", fast: true });
  });

  it("handles thinking in both suffix orders", () => {
    expect(parseModelId("claude-4.6-opus-max-thinking")).toMatchObject({ base: "claude-4.6-opus", effort: "max", thinking: true });
    expect(parseModelId("claude-opus-4-7-thinking-max")).toMatchObject({ base: "claude-opus-4-7", effort: "max", thinking: true });
    expect(parseModelId("claude-4-sonnet-thinking")).toMatchObject({ base: "claude-4-sonnet", thinking: true, effort: "" });
  });

  it("leaves bare ids alone", () => {
    expect(parseModelId("auto")).toMatchObject({ base: "auto", effort: "", fast: false, thinking: false });
    expect(parseModelId("grok-4")).toMatchObject({ base: "grok-4", effort: "" });
  });

  it("does not strip max from grok-4-max style names incorrectly", () => {
    // "-max" is an effort suffix; grok-4-max groups under base grok-4.
    expect(parseModelId("grok-4-max").base).toBe("grok-4");
  });
});

describe("groupedModelId", () => {
  it("rebuilds suffixes without effort", () => {
    expect(groupedModelId("gpt-5", false, false)).toBe("gpt-5");
    expect(groupedModelId("gpt-5", false, true)).toBe("gpt-5-fast");
    expect(groupedModelId("claude-4.6-opus", true, false)).toBe("claude-4.6-opus-thinking");
    expect(groupedModelId("x", true, true)).toBe("x-thinking-fast");
  });
});
