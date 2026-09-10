import { describe, expect, it } from "vitest";
import { findPiTool, findWebTool, nativeToolRejection } from "../protocol/tools.js";

describe("findPiTool", () => {
  it("matches case-insensitively and returns Pi's actual name", () => {
    expect(findPiTool(["read"], new Set(["Read"]))).toBe("Read");
    expect(findPiTool(["bash", "shell"], new Set(["Bash"]))).toBe("Bash");
  });

  it("prefers earlier candidates", () => {
    expect(findPiTool(["bash", "shell"], new Set(["shell", "bash"]))).toBe("bash");
  });

  it("returns undefined when nothing matches", () => {
    expect(findPiTool(["bash"], new Set(["read"]))).toBeUndefined();
  });
});

describe("nativeToolRejection", () => {
  it("names the Pi shell alias for native shell execs", () => {
    const reason = nativeToolRejection("shellArgs", new Set(["Exec"]));
    expect(reason).toContain('"Exec"');
  });

  it("matches capitalized Pi tools for read", () => {
    const reason = nativeToolRejection("readArgs", new Set(["Read"]));
    expect(reason).toContain('"Read"');
  });

  it("falls back to a generic message with no match", () => {
    const reason = nativeToolRejection("shellArgs", new Set(["other"]));
    expect(reason).toMatch(/not available in Pi/);
    expect(reason).not.toContain('Call the MCP tool "');
  });
});

describe("findWebTool", () => {
  it("finds configured web tools", () => {
    expect(findWebTool(new Set(["Web_Search"]))).toBe("Web_Search");
    expect(findWebTool(new Set(["fetch"]))).toBe("fetch");
  });

  it("returns undefined without web tools", () => {
    expect(findWebTool(new Set(["bash", "read"]))).toBeUndefined();
  });
});
