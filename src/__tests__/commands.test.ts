import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const credentialsMock = vi.hoisted(() => ({
  resolveAccessToken: vi.fn<() => Promise<string>>(),
  resolveCredential: vi.fn<() => Promise<unknown>>(),
  lastCredentialSource: vi.fn(() => "none"),
  systemCredentialsAllowed: vi.fn(() => true),
  resetCredentialCache: vi.fn(),
}));

vi.mock("../auth/credentials.js", () => credentialsMock);

import { formatModelList, formatUsage, registerCursorCommands } from "../commands.js";
import type { CursorUsageSummary } from "../auth/usage.js";
import type { ProcessedModel } from "../models/types.js";

interface CapturedNotification {
  message: string;
  type?: string;
}

function makeCtx(): ExtensionCommandContext & { notifications: CapturedNotification[] } {
  const notifications: CapturedNotification[] = [];
  return {
    notifications,
    hasUI: true,
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  } as unknown as ExtensionCommandContext & { notifications: CapturedNotification[] };
}

interface CommandEntry {
  description?: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function makePi(): ExtensionAPI & { commands: Map<string, CommandEntry> } {
  const commands = new Map<string, CommandEntry>();
  return {
    commands,
    registerCommand: (name: string, options: CommandEntry) => commands.set(name, options),
  } as unknown as ExtensionAPI & { commands: Map<string, CommandEntry> };
}

function processed(id: string, extra: Partial<ProcessedModel> = {}): ProcessedModel {
  return {
    id,
    name: extra.name ?? id,
    reasoning: extra.reasoning ?? false,
    defaultRawId: id,
    supportsImages: extra.supportsImages ?? true,
    contextWindow: extra.contextWindow ?? 200_000,
    maxTokens: extra.maxTokens ?? 64_000,
    ...(extra.thinkingLevelMap ? { thinkingLevelMap: extra.thinkingLevelMap } : {}),
  };
}

const USAGE: CursorUsageSummary = {
  billingCycleStart: "2026-09-01T00:00:00.000Z",
  billingCycleEnd: "2026-10-01T00:00:00.000Z",
  membershipType: "Pro",
  limitType: "user",
  plan: {
    enabled: true,
    used: 8400,
    limit: 20000,
    remaining: 11600,
    totalPercentUsed: 42,
    autoPercentUsed: 30,
    apiPercentUsed: 12,
  },
};

describe("registerCursorCommands", () => {
  let pi: ReturnType<typeof makePi>;
  const models = [
    processed("gpt-5", { reasoning: true, thinkingLevelMap: { off: null, low: "gpt-5-low", medium: "gpt-5", high: "gpt-5-high" } }),
    processed("grok-4"),
    processed("tab_model_x"),
  ];

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  function register(): void {
    pi = makePi();
    registerCursorCommands(pi, { getLastRegisteredModels: () => models });
  }

  it("registers cursor.model, cursor.usage and cursor.doctor", () => {
    register();
    expect([...pi.commands.keys()].sort()).toEqual(["cursor.doctor", "cursor.model", "cursor.usage"]);
    for (const command of pi.commands.values()) {
      expect(command.description).toBeTruthy();
      expect(typeof command.handler).toBe("function");
    }
  });

  it("cursor.model lists models and hides tab_/chat_ helpers", async () => {
    register();
    const ctx = makeCtx();
    await pi.commands.get("cursor.model")!.handler("", ctx);
    const message = ctx.notifications[0].message;
    expect(message).toContain("Cursor models (2)");
    expect(message).toContain("gpt-5");
    expect(message).toContain("grok-4");
    expect(message).not.toContain("tab_model_x");
    expect(message).toContain("levels=low/medium/high");
    expect(message).toContain("images");
  });

  it("cursor.model all includes helper models", async () => {
    register();
    const ctx = makeCtx();
    await pi.commands.get("cursor.model")!.handler("all", ctx);
    const message = ctx.notifications[0].message;
    expect(message).toContain("Cursor models (3 all)");
    expect(message).toContain("tab_model_x");
  });

  it("cursor.model filters case-insensitively", async () => {
    register();
    const ctx = makeCtx();
    await pi.commands.get("cursor.model")!.handler("GROK", ctx);
    const message = ctx.notifications[0].message;
    expect(message).toContain('matching "GROK"');
    expect(message).toContain("grok-4");
    expect(message).not.toContain("gpt-5\n");
  });

  it("cursor.usage reports an error when not logged in", async () => {
    register();
    credentialsMock.resolveAccessToken.mockResolvedValueOnce("");
    const ctx = makeCtx();
    await pi.commands.get("cursor.usage")!.handler("", ctx);
    expect(ctx.notifications[0].type).toBe("error");
    expect(ctx.notifications[0].message).toMatch(/login cursor/i);
  });

  it("cursor.usage renders plan usage", async () => {
    register();
    credentialsMock.resolveAccessToken.mockResolvedValueOnce("token-1");
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            billingCycleEnd: "1759276800000",
            planUsage: { totalPercentUsed: 42, autoPercentUsed: 30, apiPercentUsed: 12, includedSpend: 8400, limit: 20000 },
            spendLimitUsage: { limitType: "user" },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;

    const ctx = makeCtx();
    await pi.commands.get("cursor.usage")!.handler("", ctx);
    const message = ctx.notifications[0].message;
    expect(message).toContain("Usage • Pro");
    expect(message).toContain("8,400 / 20,000 used");
    expect(message).toContain("42% used");
    expect(message).toContain("Auto requests");
    expect(message).toContain("dashboard");
  });

  it("cursor.usage surfaces fetch failures", async () => {
    register();
    credentialsMock.resolveAccessToken.mockResolvedValueOnce("token-1");
    globalThis.fetch = vi.fn(async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    const ctx = makeCtx();
    await pi.commands.get("cursor.usage")!.handler("", ctx);
    expect(ctx.notifications[0].type).toBe("error");
    expect(ctx.notifications[0].message).toContain("503");
  });

  it("cursor.doctor renders a report without credentials", async () => {
    register();
    credentialsMock.resolveCredential.mockResolvedValueOnce(null);
    const ctx = makeCtx();
    await pi.commands.get("cursor.doctor")!.handler("", ctx);
    const message = ctx.notifications[0].message;
    expect(message).toContain("provider=cursor");
    expect(message).toContain("agentUrl=");
    expect(message).toContain("commands=/cursor.model /cursor.usage /cursor.doctor");
  });
});

describe("formatUsage", () => {
  it("renders team membership and a usage bar", () => {
    const text = formatUsage({ ...USAGE, membershipType: "Team", limitType: "team" });
    expect(text).toContain("Usage • Team");
    expect(text).toContain("team balance");
    expect(text).toMatch(/█+░+/);
  });

  it("renders missing plan gracefully", () => {
    const text = formatUsage({ membershipType: "Pro" });
    expect(text).toContain("Plan usage unavailable");
  });

  it("renders on-demand spend when present", () => {
    const text = formatUsage({ ...USAGE, onDemandSpendCents: 1234 });
    expect(text).toContain("On-demand spend   $12.34");
  });
});

describe("formatModelList", () => {
  it("handles an empty registry", () => {
    const text = formatModelList([], "", false);
    expect(text).toContain("Cursor models (0)");
    expect(text).toContain("No models registered");
  });
});
