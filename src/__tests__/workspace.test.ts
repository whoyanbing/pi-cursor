import { afterEach, describe, expect, it } from "vitest";
import {
  clearWorkspaceCwds,
  forgetSessionCwd,
  rememberSessionCwd,
  resolveWorkspaceCwd,
} from "../workspace.js";

afterEach(() => {
  clearWorkspaceCwds();
});

describe("workspace cwd", () => {
  it("falls back to process.cwd when nothing was remembered", () => {
    expect(resolveWorkspaceCwd("missing")).toBe(process.cwd());
  });

  it("returns the cwd remembered for a session id", () => {
    rememberSessionCwd("sess-1", "/tmp/project-a");
    rememberSessionCwd("sess-2", "/tmp/project-b");
    expect(resolveWorkspaceCwd("sess-1")).toBe("/tmp/project-a");
    expect(resolveWorkspaceCwd("sess-2")).toBe("/tmp/project-b");
  });

  it("uses the last remembered cwd when the session id is unknown", () => {
    rememberSessionCwd("sess-1", "/tmp/project-a");
    expect(resolveWorkspaceCwd()).toBe("/tmp/project-a");
    expect(resolveWorkspaceCwd("other")).toBe("/tmp/project-a");
  });

  it("forgets a session without clearing the last cwd", () => {
    rememberSessionCwd("sess-1", "/tmp/project-a");
    forgetSessionCwd("sess-1");
    expect(resolveWorkspaceCwd("sess-1")).toBe("/tmp/project-a");
  });
});
