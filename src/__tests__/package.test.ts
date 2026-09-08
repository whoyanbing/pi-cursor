import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf8")) as {
  name: string;
  type: string;
  files: string[];
  pi: { extensions: string[] };
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
};

describe("package metadata", () => {
  it("is named pi-cursor", () => {
    expect(pkg.name).toBe("pi-cursor");
    expect(pkg.type).toBe("module");
  });

  it("points pi at the source entry", () => {
    expect(pkg.pi.extensions).toEqual(["./src/index.ts"]);
  });

  it("ships src, proto and LICENSE", () => {
    expect(pkg.files).toContain("src");
    expect(pkg.files).toContain("proto");
    expect(pkg.files).toContain("LICENSE");
  });

  it("depends on @bufbuild/protobuf and peers on a pinned pi range", () => {
    expect(pkg.dependencies["@bufbuild/protobuf"]).toBeTruthy();
    expect(pkg.peerDependencies["@earendil-works/pi-ai"]).toMatch(/^\^/);
    expect(pkg.peerDependencies["@earendil-works/pi-coding-agent"]).toMatch(/^\^/);
  });
});
