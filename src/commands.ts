/**
 * Slash commands: /cursor.model, /cursor.usage, /cursor.doctor.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { resolveAccessToken, resolveCredential } from "./auth/credentials.js";
import { fetchCursorUsage, formatUnits, formatUsd, type CursorUsageSummary } from "./auth/usage.js";
import { DASHBOARD_URL, getAgentUrl } from "./config.js";
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

export function formatUsage(usage: CursorUsageSummary): string {
  const title = `Usage • ${usage.membershipType || "Pro"}`;
  const lines: string[] = [title, ""];

  if (usage.plan) {
    lines.push(
      `Plan (included)   ${formatUnits(usage.plan.used)} / ${formatUnits(usage.plan.limit)} used`,
    );
    lines.push(`                  ${percentText(usage.plan.totalPercentUsed)}  ${bar(usage.plan.totalPercentUsed)}`);
    if (usage.plan.autoPercentUsed !== null && usage.plan.autoPercentUsed !== undefined) {
      lines.push(`  Auto requests   ${percentText(usage.plan.autoPercentUsed)}`);
    }
    if (usage.plan.apiPercentUsed !== null && usage.plan.apiPercentUsed !== undefined) {
      lines.push(`  API requests    ${percentText(usage.plan.apiPercentUsed)}`);
    }
    if (usage.plan.remaining !== null && usage.plan.remaining !== undefined) {
      lines.push(`  Remaining       ${formatUnits(usage.plan.remaining)}`);
    }
  } else {
    lines.push("Plan usage unavailable for this account.");
  }

  if (usage.onDemandSpendCents !== null && usage.onDemandSpendCents !== undefined) {
    lines.push("", `On-demand spend   ${formatUsd(usage.onDemandSpendCents)}`);
  }
  if (usage.limitType === "team") {
    lines.push("", "Billing: team spend limit (shared team balance).");
  }
  if (usage.billingCycleEnd) {
    lines.push(`Resets            ${usage.billingCycleEnd}`);
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
  pi.registerCommand("cursor.model", {
    description: "List Cursor models registered by this provider",
    handler: async (args, ctx) => {
      const all = /\ball\b/i.test(args ?? "");
      const filter = (args ?? "").replace(/\ball\b/i, "");
      emit(ctx, formatModelList(options.getLastRegisteredModels(), filter, all));
    },
  });

  pi.registerCommand("cursor.usage", {
    description: "Show Cursor plan usage and on-demand spend",
    handler: async (_args, ctx) => {
      try {
        const token = await resolveAccessToken();
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

  pi.registerCommand("cursor.doctor", {
    description: "Show sanitized Cursor provider diagnostics",
    handler: async (_args, ctx) => {
      try {
        // Refresh the credential source so the report reflects reality.
        await resolveCredential();
      } catch {
        // Diagnostics still render without credentials.
      }
      emit(ctx, diagnosticsReport());
    },
  });
}
