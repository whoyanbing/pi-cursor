/**
 * pi-cursor extension entry point.
 *
 * Registers the `cursor-native` API provider and the `cursor` Pi provider with
 * OAuth login, model discovery, and the four slash commands.
 */
import type { Model, Provider, ProviderAuth } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import { sessionEntryToContextMessages, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CURSOR_API, PROVIDER_ID, PROVIDER_NAME, getAgentUrl, prewarmClientVersion } from "./config.js";
import { loginCursor, refreshAccessToken } from "./auth/oauth.js";
import { resolveCredential } from "./auth/credentials.js";
import { registerCursorCommands } from "./commands.js";
import { shouldCancelThresholdCompact } from "./compaction-guard.js";
import { cachedModels, startupCatalog, writeCache } from "./models/catalog.js";
import { clearAllBridges, clearBridgesForSession } from "./protocol/bridge.js";
import { discoverModels } from "./models/discovery.js";
import { processAndRegister, processModels, toProviderModels } from "./models/processing.js";
import { setRouting } from "./models/registry.js";
import type { ProcessedModel } from "./models/types.js";
import { streamCursor } from "./protocol/stream.js";
import { clearAllUsage, clearUsageForSession, estimatePromptTokens } from "./protocol/usage.js";
import { closeAllSessions } from "./transport/client.js";
import { clearWorkspaceCwds, forgetSessionCwd, rememberSessionCwd } from "./workspace.js";

const COMPACT_CONTEXT_STATUS = "pi-cursor-compact-context";

function clearCompactStatus(ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }): void {
  ctx.ui.setStatus(COMPACT_CONTEXT_STATUS, undefined);
}
let lastRegisteredModels: ProcessedModel[] = [];

function clearSessionRuntime(sessionId: string | undefined): void {
  const id = sessionId?.trim();
  if (id) {
    clearBridgesForSession(id);
    clearUsageForSession(id);
    forgetSessionCwd(id);
  } else {
    clearAllBridges();
    clearAllUsage();
    clearWorkspaceCwds();
  }
}

export function shouldCloseTransportOnShutdown(reason: string): boolean {
  return reason === "quit" || reason === "reload";
}

export default function (pi: ExtensionAPI): void {
  registerApiProvider({ api: CURSOR_API, stream: streamCursor, streamSimple: streamCursor }, "pi-cursor");
  // Off the request path: resolve the local CLI version before the first turn.
  void prewarmClientVersion();

  // Synchronous startup: register the bundled/cached catalog immediately so
  // /model works before any network call. Pi calls refreshModels in background.
  const startup = processAndRegister(startupCatalog());
  lastRegisteredModels = startup;

  const ambientAuth: NonNullable<ProviderAuth["apiKey"]> = {
    name: "Cursor access token or desktop credentials",
    async check({ credential, ctx, signal }) {
      signal.throwIfAborted();
      if (credential) return credential.key ? { type: "api_key", source: "stored credential" } : undefined;
      if ((await ctx.env("CURSOR_ACCESS_TOKEN"))?.trim()) return { type: "api_key", source: "CURSOR_ACCESS_TOKEN" };
      const resolved = await resolveCredential({ signal, skipPiStore: true, refresh: false });
      return resolved ? { type: "api_key", source: resolved.source } : undefined;
    },
    async resolve({ credential, ctx, signal }) {
      signal.throwIfAborted();
      if (credential) return credential.key ? { auth: { apiKey: credential.key }, source: "stored credential" } : undefined;
      const env = (await ctx.env("CURSOR_ACCESS_TOKEN"))?.trim();
      if (env) return { auth: { apiKey: env }, source: "CURSOR_ACCESS_TOKEN" };
      const resolved = await resolveCredential({ signal, skipPiStore: true });
      return resolved ? { auth: { apiKey: resolved.accessToken }, source: resolved.source } : undefined;
    },
  };
  const oauth: NonNullable<ProviderAuth["oauth"]> = {
    name: PROVIDER_NAME,
    isSubscription: true,
    async login(interaction) {
      const credentials = await loginCursor({
        onAuth: ({ url }) => interaction.notify({ type: "auth_url", url }),
      }, interaction.signal);
      return { ...credentials, type: "oauth" };
    },
    async refresh(credentials, signal) {
      return { ...await refreshAccessToken(credentials.refresh, signal), type: "oauth" };
    },
    async toAuth(credentials) { return { apiKey: credentials.access }; },
  };
  const asModels = (models: ProcessedModel[]): Model<typeof CURSOR_API>[] => toProviderModels(models).map((model) => ({
    ...model, api: CURSOR_API, provider: PROVIDER_ID, baseUrl: getAgentUrl(), compat: undefined,
  }));
  let models = asModels(startup);
  const provider: Provider<typeof CURSOR_API> = {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    baseUrl: getAgentUrl(),
    auth: { apiKey: ambientAuth, oauth },
    getModels: () => models,
    stream: (model, context, options) => streamCursor(model, context, options),
    streamSimple: streamCursor,
    async refreshModels(context) {
      if (!context.allowNetwork || context.signal.aborted) return;
      const credential = context.credential;
      const access = credential?.type === "oauth" ? credential.access : credential?.key;
      const token = access || (await resolveCredential({ signal: context.signal, skipPiStore: true }))?.accessToken;
      if (!token || (!context.force && cachedModels())) return;
      try {
        const raw = await discoverModels(token, context.signal);
        context.signal.throwIfAborted();
        if (raw.length === 0) return;
        const processed = processModels(raw);
        const next = asModels(processed.models);
        await context.publish({
          persist: { models: next, checkedAt: Date.now() },
          update: () => {
            writeCache(raw);
            setRouting(processed.registry);
            lastRegisteredModels = processed.models;
            models = next;
          },
        });
      } catch {
        context.signal.throwIfAborted();
        // Keep the last usable catalog on transient discovery failure.
      }
    },
  };
  pi.registerProvider(provider);

  registerCursorCommands(pi, { getLastRegisteredModels: () => lastRegisteredModels });

  pi.on("session_start", async (_event, ctx) => {
    rememberSessionCwd(ctx.sessionManager.getSessionId(), ctx.cwd);
    try {
      // Availability/notice only: request-time OAuth refresh belongs to Pi.
      await resolveCredential({ refresh: false });
    } catch {
      // Login is optional at session start.
    }
  });

  // Pi's between-turn compact check trusts last-assistant usage. Cursor writes
  // the pre-compact prompt size there, so a successful compact still looks like
  // 94%+ and immediately runs again. Skip until usage actually drops, and drop
  // parked Run streams so the next call rebuilds from the summary. Other
  // providers are left alone — this hook is process-wide.
  pi.on("session_before_compact", (event, ctx) => {
    if (shouldCancelThresholdCompact(event, ctx.model?.provider)) return { cancel: true };
  });
  pi.on("session_compact", (_event, ctx) => {
    clearCompactStatus(ctx);
    if (ctx.model?.provider !== PROVIDER_ID) return;
    clearSessionRuntime(ctx.sessionManager.getSessionId());

    // Pi deliberately reports context as unknown between compaction and the
    // first persisted assistant usage. Show a temporary provider-side estimate
    // in the footer, then remove it after that first sub-turn completes.
    const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
    const tokens = estimatePromptTokens(ctx.model, {
      systemPrompt: ctx.getSystemPrompt(),
      messages: messages as never,
      tools: [],
    });
    const window = ctx.model.contextWindow;
    if (tokens > 0 && window > 0) {
      ctx.ui.setStatus(
        COMPACT_CONTEXT_STATUS,
        `Cursor context ~${((tokens / window) * 100).toFixed(1)}% after compact`,
      );
    }
  });
  pi.on("turn_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
    const usage = event.message.usage;
    if ((usage.totalTokens ?? 0) <= 0) return;
    clearCompactStatus(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    clearCompactStatus(ctx);
    clearSessionRuntime(ctx.sessionManager.getSessionId());
  });
  pi.on("model_select", (_event, ctx) => {
    clearCompactStatus(ctx);
  });
  pi.on("session_shutdown", (event, ctx) => {
    clearCompactStatus(ctx);
    clearSessionRuntime(ctx.sessionManager.getSessionId());
    if (shouldCloseTransportOnShutdown(event.reason)) {
      clearWorkspaceCwds();
      closeAllSessions();
    }
  });
}
