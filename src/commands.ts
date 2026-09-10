/**
 * Slash commands: /cursor.model, /cursor.usage, /cursor.doctor.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fetchCursorUsage, formatUsd, type CursorUsageSummary } from "./auth/usage.js";
import { DASHBOARD_URL, PROVIDER_ID, getAgentUrl } from "./config.js";
import { diagnosticsReport } from "./diagnostics.js";
import type { ProcessedModel } from "./models/types.js";

export interface CursorCommandOptions {
  getLastRegisteredModels: () => ProcessedModel[];
}

type NotifyLevel = "info" | "warning" | "error";

function emit(ctx: ExtensionCommandContext, text: string, level: NotifyLevel = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(text, level);
    return;
  }
  if (level === "error") console.error(text);
  else console.log(text);
}

function bar(percent: number | null, width = 20): string {
  const value = Math.max(0, Math.min(100, percent ?? 0));
  const filled = Math.round((value / 100) * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

function percentText(percent: number | null): string {
  return percent === null ? "n/a" : `${Math.round(percent)}% used`;
}

function formatDate(iso: string | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatUsage(usage: CursorUsageSummary): string {
  const lines: string[] = [`Usage • ${usage.membershipType || "Pro"}`, ""];

  const { total, auto, api } = usage.percents;
  if (total !== null) {
    lines.push(`Included usage     ${percentText(total)}  ${bar(total)}`);
    if (auto !== null) lines.push(`  Auto requests    ${percentText(auto)}`);
    if (api !== null) lines.push(`  API requests     ${percentText(api)}`);
  } else {
    lines.push("Plan usage unavailable for this account.");
  }

  // Spend figures (cents): the purchased monthly allowance (cap) vs total
  // spend. The paid allowance is consumed first; promotional "bonus" spend is
  // free and keeps the account usable after the cap — which is exactly when
  // the server sets displayMessage "You've hit your usage limit". So that
  // banner refers to the *paid cap*, not the percent gauge, and is rendered
  // here as the cap's status rather than an alarming plan warning.
  if (usage.spendCapCents !== null) {
    const spent = usage.totalSpendCents ?? 0;
    const over = Math.max(0, spent - usage.spendCapCents);
    const capped = Math.min(spent, usage.spendCapCents);
    lines.push(
      `Spend cap          ${formatUsd(capped)} / ${formatUsd(usage.spendCapCents)}${over > 0 ? ` (bonus overage ${formatUsd(over)})` : ""}`,
    );
    if (usage.bonusSpendCents !== null && usage.bonusSpendCents > 0) {
      lines.push(`  Bonus spend      ${formatUsd(usage.bonusSpendCents)} (promotional, free)`);
    }
    if (usage.limitHit) {
      lines.push("  Paid allowance used up — bonus usage keeps working.");
    }
  }

  if (usage.statusMessage && !usage.limitHit) {
    // Any other server-written status is still worth surfacing.
    lines.push("");
    lines.push(usage.statusMessage);
  }
  if (usage.billingCycleEnd) {
    lines.push(`Resets             ${formatDate(usage.billingCycleEnd)}`);
  }
  lines.push("", `Dashboard: ${DASHBOARD_URL}`);
  return lines.join("\n");
}

export function formatModelList(models: readonly ProcessedModel[], filter: string, all: boolean): string {
  const needle = filter.trim().toLowerCase();
  let rows = models;
  if (!all) rows = rows.filter((model) => !/^(?:tab_|chat_)/i.test(model.id));
  if (needle) {
    rows = rows.filter(
      (model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle),
    );
  }

  const header = `Cursor models (${rows.length}${all ? " all" : ""}${needle ? ` matching "${filter.trim()}"` : ""})`;
  const lines: string[] = [header, `endpoint=${getAgentUrl()}`, ""];
  if (rows.length === 0) {
    lines.push("No models registered. Run /login cursor first, then /model to refresh.");
    return lines.join("\n");
  }

  const width = Math.max(8, ...rows.map((model) => model.id.length));
  for (const model of rows) {
    const levels = Object.entries(model.thinkingLevelMap ?? {})
      .filter(([level, value]) => level !== "off" && typeof value === "string")
      .map(([level]) => level)
      .join("/");
    const flags = [model.reasoning ? "thinking" : "", levels ? `levels=${levels}` : "", model.supportsImages ? "images" : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(
      `${model.id.padEnd(width)}  ctx ${String(model.contextWindow).padStart(7)}  ${model.name}${flags ? `  [${flags}]` : ""}`,
    );
  }
  lines.push("", "Pass `all` to include tab/chat helper models. Use /model to switch.");
  return lines.join("\n");
}

export function registerCursorCommands(pi: ExtensionAPI, options: CursorCommandOptions): void {
  pi.registerCommand("cursor.usage", {
    description: "Show Cursor plan usage and on-demand spend",
    handler: async (_args, ctx) => {
      try {
        // Use the same runtime/account as model requests, including SDK-owned
        // credential stores and Pi's serialized OAuth refresh.
        const token = (await ctx.modelRegistry.getProviderAuth(PROVIDER_ID))?.auth.apiKey;
        if (!token) {
          emit(ctx, "Not logged in to Cursor. Run /login cursor first.", "error");
          return;
        }
        emit(ctx, formatUsage(await fetchCursorUsage(token)));
      } catch (error) {
        emit(ctx, `Cursor usage unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });

  pi.registerCommand("cursor.model", {
    description: "List Cursor models registered by this provider",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args ?? "");
      const filter = (args ?? "").replace(/\ball\b/i, "");
      emit(ctx, formatModelList(options.getLastRegisteredModels(), filter, all));
    },
  });

  pi.registerCommand("cursor.doctor", {
    description: "Show sanitized Cursor provider diagnostics",
    handler: async (_args, ctx) => {
      const status = ctx.modelRegistry.getProviderAuthStatus(PROVIDER_ID);
      emit(ctx, diagnosticsReport(status.configured ? status.label ?? status.source : "none"));
    },
  });
}
