/**
 * Conversation export.
 *
 * Markdown is meant to be readable in a text editor and on GitHub, so the
 * transcript keeps the model/provider attribution and the measured metrics —
 * that is the part a benchmark export is for.
 */

import type { Conversation, StoredMessage } from "../../shared/types.ts";

export interface ConversationExport {
  conversation: Conversation;
  messages: StoredMessage[];
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "unavailable";
  return value.toLocaleString("en-US");
}

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "unavailable";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatSpeed(tokensPerSecond: number | null | undefined, estimated: boolean): string {
  if (tokensPerSecond === null || tokensPerSecond === undefined) return "unavailable";
  return `${tokensPerSecond.toFixed(1)} tok/s${estimated ? " (estimated)" : ""}`;
}

/** Metrics appendix for one assistant message. */
export function metricsFooter(message: StoredMessage): string {
  const m = message.metrics;
  if (!m) return "";
  const parts = [
    `TTFT ${formatDuration(m.ttftMs)}`,
    `first response ${formatDuration(m.timeToFirstResponseMs)}`,
    `total ${formatDuration(m.totalMs)}`,
    `speed ${formatSpeed(m.tokensPerSecond, m.estimated)}`,
    `output tokens ${formatNumber(m.outputTokens)}${
      m.outputTokens !== null && !m.providerReportedTokens ? " (estimated)" : ""
    }`,
    `input tokens ${formatNumber(m.inputTokens)}`,
    `context window ${formatNumber(m.contextWindow)}`,
  ];
  return `*${parts.join(" · ")}*`;
}

export function toMarkdown(exported: ConversationExport): string {
  const { conversation, messages } = exported;
  const lines: string[] = [];

  lines.push(`# ${conversation.title}`);
  lines.push("");
  lines.push(`- Mode: ${conversation.mode === "compare" ? "Comparison" : "Single model"}`);
  lines.push(`- Created: ${conversation.createdAt}`);
  lines.push(`- Updated: ${conversation.updatedAt}`);
  lines.push(`- Messages: ${messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of messages) {
    if (message.role === "user") {
      lines.push("## Prompt");
      lines.push("");
      lines.push(message.content);
      lines.push("");
    } else if (message.role === "assistant") {
      const who = [message.modelName ?? message.modelId ?? "Model", message.providerId ? undefined : undefined]
        .filter(Boolean)
        .join(" · ");
      lines.push(`### Response${who ? ` — ${who}` : ""}`);
      lines.push("");
      lines.push(message.content);
      lines.push("");
      const footer = metricsFooter(message);
      if (footer) {
        lines.push(footer);
        lines.push("");
      }
      if (message.error) {
        lines.push(`> Error: ${message.error}`);
        lines.push("");
      }
    }
    lines.push("");
  }

  if (conversation.mode === "compare") {
    lines.push("---");
    lines.push("");
    lines.push(
      "Comparison runs measure each model independently; per-response metrics above are from the run that produced them.",
    );
  }

  return lines.join("\n");
}

/** Benchmark export: the metrics only, as CSV. */
export function toCsv(exported: ConversationExport): string {
  const header = [
    "conversation_title",
    "created_at",
    "role",
    "model",
    "provider",
    "ttft_ms",
    "time_to_first_response_ms",
    "total_ms",
    "output_tokens",
    "tokens_per_second",
    "estimated",
    "input_tokens",
    "context_window",
    "status",
  ];
  const rows = [header.join(",")];
  for (const message of exported.messages) {
    if (message.role !== "assistant") continue;
    const m = message.metrics;
    rows.push(
      [
        JSON.stringify(exported.conversation.title),
        exported.conversation.createdAt,
        message.role,
        JSON.stringify(message.modelName ?? message.modelId ?? ""),
        JSON.stringify(message.providerId ?? ""),
        m?.ttftMs ?? "",
        m?.timeToFirstResponseMs ?? "",
        m?.totalMs ?? "",
        m?.outputTokens ?? "",
        m?.tokensPerSecond ?? "",
        m?.estimated ? "yes" : "no",
        m?.inputTokens ?? "",
        m?.contextWindow ?? "",
        message.status,
      ].join(","),
    );
  }
  return rows.join("\n");
}
