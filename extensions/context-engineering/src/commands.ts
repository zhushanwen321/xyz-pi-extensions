import type { ContextEngineeringConfig } from "./config";
import { parseLevelArgs } from "./config";
import type { CompressionStats } from "./compressor";

// ── 格式化辅助 ──

function formatConfigSummary(config: ContextEngineeringConfig): string {
  const lines = [
    "Context Engineering Plugin",
    "═══════════════════════════",
    `Status: ${config.enabled ? "enabled" : "disabled"}`,
    "",
  ];

  if (config.mc.enabled) {
    lines.push("MC (Microcompact):");
    lines.push("  Enabled: true");
    lines.push(
      `  Gap: ${config.mc.gapThresholdMinutes}min | Keep recent: ${config.mc.keepRecent}`,
    );
  } else {
    lines.push("MC (Microcompact): disabled");
  }

  lines.push("");

  if (config.budget.enabled) {
    lines.push("Budget (Tool result budget):");
    lines.push("  Enabled: true");
    lines.push(
      `  Max: ${config.budget.maxToolResultCharsPerMessage} chars | Preview: ${config.budget.previewSize} chars`,
    );
  } else {
    lines.push("Budget (Tool result budget): disabled");
  }

  lines.push("");

  if (config.l0.enabled) {
    lines.push("L0 (Zero-cost cleanup):");
    lines.push("  Enabled: true");
    lines.push(
      `  Expire: ${config.l0.expireMinutes}min | Bash truncate: ${config.l0.bashTruncateChars} chars | Thinking: ${config.l0.thinkingExpireMinutes}min`,
    );
    lines.push(`  Protect recent: ${config.l0.protectRecentTurns} turns | Keep recent: ${config.l0.keepRecent}`);
  } else {
    lines.push("L0 (Zero-cost cleanup): disabled");
  }

  lines.push("");

  if (config.l1.enabled) {
    lines.push("L1 (Rule-based compression):");
    lines.push("  Enabled: true");
    lines.push(
      `  Threshold: ${config.l1.summaryThresholdChars} chars | Head: ${config.l1.keepHeadLines} lines | Tail: ${config.l1.keepTailLines} lines | Protect: ${config.l1.protectRecentTurns} turns`,
    );
  } else {
    lines.push("L1 (Rule-based compression): disabled");
  }

  lines.push("");

  if (config.l2.enabled) {
    lines.push("L2 (Emergency compression):");
    lines.push("  Enabled: true");
    const thresholdPercent = Math.round(config.l2.emergencyThreshold * 100);
    lines.push(
      `  Threshold: ${thresholdPercent}% | Protect recent: ${config.l2.protectRecentTurns} turns`,
    );
  } else {
    lines.push("L2 (Emergency compression): disabled");
  }

  return lines.join("\n");
}

function formatStats(stats: CompressionStats): string {
  const lines = [
    "Statistics:",
    `  MC: triggered=${stats.mcTriggered}, cleared=${stats.mcCleared}`,
    `  Budget: persisted=${stats.budgetPersisted}`,
    `  L0 expired: ${stats.l0Expired} | truncated: ${stats.l0Truncated} | thinking cleared: ${stats.l0ThinkingCleared}`,
    `  L1 condensed: ${stats.l1Condensed}`,
    `  L2 triggered: ${stats.l2Triggered}`,
  ];
  return lines.join("\n");
}

const USAGE_HELP = [
  "Usage:",
  "  /context-engineering          — Show current config and stats",
  "  /context-engineering mc on    — Enable Microcompact",
  "  /context-engineering mc off   — Disable Microcompact",
  "  /context-engineering budget on  — Enable Budget",
  "  /context-engineering budget off — Disable Budget",
  "  /context-engineering l0 on    — Enable L0 compression",
  "  /context-engineering l0 off   — Disable L0 compression",
  "  /context-engineering l1 on    — Enable L1 compression",
  "  /context-engineering l1 off   — Disable L1 compression",
  "  /context-engineering l2 on    — Enable L2 compression",
  "  /context-engineering l2 off   — Disable L2 compression",
  "  /context-engineering global on  — Enable entire plugin",
  "  /context-engineering global off — Disable entire plugin",
].join("\n");

// ── 导出 ──

export function handleContextEngineeringCommand(
  args: string | undefined,
  config: ContextEngineeringConfig,
  stats: CompressionStats,
): string {
  if (!args || args.trim().length === 0) {
    return formatConfigSummary(config) + "\n\n" + formatStats(stats);
  }

  const parsed = parseLevelArgs(args);
  if (!parsed) {
    return USAGE_HELP;
  }

  const { target, action } = parsed;
  const onOff = action === "on";

  switch (target) {
    case "global":
      config.enabled = onOff;
      return `Context engineering ${action === "on" ? "enabled" : "disabled"}.`;
    case "mc":
      config.mc.enabled = onOff;
      return `MC (Microcompact) ${action === "on" ? "enabled" : "disabled"}.`;
    case "budget":
      config.budget.enabled = onOff;
      return `Budget (Tool result budget) ${action === "on" ? "enabled" : "disabled"}.`;
    case "l0":
      config.l0.enabled = onOff;
      return `L0 (Zero-cost cleanup) ${action === "on" ? "enabled" : "disabled"}.`;
    case "l1":
      config.l1.enabled = onOff;
      return `L1 (Rule-based compression) ${action === "on" ? "enabled" : "disabled"}.`;
    case "l2":
      config.l2.enabled = onOff;
      return `L2 (Emergency compression) ${action === "on" ? "enabled" : "disabled"}.`;
  }
}

export function handleContextStatsCommand(stats: CompressionStats): string {
  return [
    "Context Compression Statistics",
    "══════════════════════════════",
    formatStats(stats),
  ].join("\n");
}
