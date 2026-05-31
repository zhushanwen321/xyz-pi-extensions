import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ── 配置嵌套类型 ──

export interface L0Config {
  enabled: boolean;
  expireMinutes: number;
  bashTruncateChars: number;
  thinkingExpireMinutes: number;
  protectRecentTurns: number;
}

export interface L1Config {
  enabled: boolean;
  summaryThresholdChars: number;
  keepHeadLines: number;
  keepTailLines: number;
}

export interface L2Config {
  enabled: boolean;
  emergencyThreshold: number;
  protectRecentTurns: number;
}

export interface ContextEngineeringConfig {
  enabled: boolean;
  l0: L0Config;
  l1: L1Config;
  l2: L2Config;
}

// ── 默认配置 ──

export const DEFAULT_CONFIG: ContextEngineeringConfig = {
  enabled: true,
  l0: {
    enabled: true,
    expireMinutes: 30,
    bashTruncateChars: 4000,
    thinkingExpireMinutes: 5,
    protectRecentTurns: 2,
  },
  l1: {
    enabled: true,
    summaryThresholdChars: 8000,
    keepHeadLines: 10,
    keepTailLines: 5,
  },
  l2: {
    enabled: true,
    emergencyThreshold: 0.9,
    protectRecentTurns: 3,
  },
};

// ── 深合并工具 ──

function deepMerge<T>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overVal = override[key];
    if (
      baseVal != null &&
      overVal != null &&
      typeof baseVal === "object" &&
      typeof overVal === "object" &&
      !Array.isArray(baseVal) &&
      !Array.isArray(overVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overVal as Record<string, unknown>,
      );
    } else {
      result[key] = overVal;
    }
  }
  return result as T;
}

// ── 读取配置 ──

export function loadConfig(
  settingsPath?: string,
): ContextEngineeringConfig {
  const filePath =
    settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");

  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { ...DEFAULT_CONFIG };
  }

  const override = parsed["context-engineering"];
  if (override == null || typeof override !== "object") {
    return { ...DEFAULT_CONFIG };
  }

  return deepMerge<ContextEngineeringConfig>(
    DEFAULT_CONFIG,
    override as Record<string, unknown>,
  );
}

// ── 命令参数解析 ──

export function parseLevelArgs(
  args: string,
): { target: "global" | "l0" | "l1" | "l2"; action: "on" | "off" } | null {
  const tokens = args.trim().split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }

  const [rawTarget, rawAction] = tokens;

  const validTargets = new Set(["global", "l0", "l1", "l2"]);
  const validActions = new Set(["on", "off"]);

  if (!validTargets.has(rawTarget) || !validActions.has(rawAction)) {
    return null;
  }

  return {
    target: rawTarget as "global" | "l0" | "l1" | "l2",
    action: rawAction as "on" | "off",
  };
}
