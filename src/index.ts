/**
 * pi-cursor extension entry point.
 *
 * Registers the `cursor-native` API provider and the `cursor` Pi provider with
 * OAuth login, model discovery, and the three slash commands.
 */
import type { OAuthCredentials } from "@earendil-works/pi-ai";
import { registerApiProvider } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CURSOR_API, PROVIDER_ID, PROVIDER_NAME, getAgentUrl } from "./config.js";
import { loginCursor, refreshAccessToken } from "./auth/oauth.js";
import { resolveCredential } from "./auth/credentials.js";
import { registerCursorCommands } from "./commands.js";
import { shouldCancelThresholdCompact } from "./compaction-guard.js";
import { cachedModels, startupCatalog, writeCache } from "./models/catalog.js";
import { clearAllBridges, clearBridgesForSession } from "./protocol/bridge.js";
import { discoverModels } from "./models/discovery.js";
import { processAndRegister, toProviderModels } from "./models/processing.js";
import type { ProcessedModel } from "./models/types.js";
import { streamCursor } from "./protocol/stream.js";

let lastRegisteredModels: ProcessedModel[] = [];

function registerCursorApi(): void {
  registerApiProvider(
    { api: CURSOR_API, stream: streamCursor, streamSimple: streamCursor },
    "pi-cursor",
  );
}

export default async function (pi: ExtensionAPI): Promise<void> {
  registerCursorApi();

  // Synchronous startup: register the bundled/cached catalog immediately so
  // /model works before any network call. Pi calls refreshModels in background.
  const startup = processAndRegister(startupCatalog());
  lastRegisteredModels = startup;

  const oauth: NonNullable<ProviderConfig["oauth"]> = {
    name: PROVIDER_NAME,
    isSubscription: true,
    async login(callbacks) {
      const credentials = await loginCursor(callbacks);
      return credentials as OAuthCredentials;
    },
    async refreshToken(credentials, signal) {
      const refreshed = await refreshAccessToken(credentials.refresh, signal);
      return refreshed as OAuthCredentials;
    },
    getApiKey: (credentials) => credentials.access,
  };

  pi.registerProvider(PROVIDER_ID, {
    name: PROVIDER_NAME,
    baseUrl: getAgentUrl(),
    api: CURSOR_API,
    models: toProviderModels(startup),
    oauth,
    streamSimple: streamCursor as unknown as ProviderConfig["streamSimple"],
    async refreshModels(context) {
      if (!context.allowNetwork || context.signal?.aborted) return toProviderModels(lastRegisteredModels);
      const credential = context.credential;
      const access = credential && "access" in credential ? String(credential.access ?? "") : "";
      const token = access || (await resolveCredential())?.accessToken || "";
      if (!token) return toProviderModels(lastRegisteredModels);
      if (!context.force) {
        // Background refresh: skip while the discovery cache is fresh.
        if (cachedModels()) return toProviderModels(lastRegisteredModels);
      }
      try {
        const raw = await discoverModels(token, context.signal);
        if (raw.length === 0) return toProviderModels(lastRegisteredModels);
        writeCache(raw);
        const processed = processAndRegister(raw);
        lastRegisteredModels = processed;
        const next = toProviderModels(processed);
        await context.publish({
          persist: {
            models: next.map((model) => ({
              ...model,
              api: CURSOR_API,
              provider: PROVIDER_ID,
              baseUrl: getAgentUrl(),
            })),
            checkedAt: Date.now(),
          },
        });
        return next;
      } catch {
        return toProviderModels(lastRegisteredModels);
      }
    },
  });

  registerCursorCommands(pi, { getLastRegisteredModels: () => lastRegisteredModels });

  // Pi's between-turn compact check trusts last-assistant usage. Cursor writes
  // the pre-compact prompt size there, so a successful compact still looks like
  // 94%+ and immediately runs again. Skip until usage actually drops, and drop
  // parked Run streams so the next call rebuilds from the summary. Other
  // providers are left alone — this hook is process-wide.
  pi.on("session_before_compact", (event, ctx) => {
    if (shouldCancelThresholdCompact(event, ctx.model?.provider)) return { cancel: true };
  });
  pi.on("session_compact", (_event, ctx) => {
    if (ctx.model?.provider !== PROVIDER_ID) return;
    const sessionId = ctx.sessionManager.getSessionId()?.trim();
    if (sessionId) clearBridgesForSession(sessionId);
    else clearAllBridges();
  });
}
