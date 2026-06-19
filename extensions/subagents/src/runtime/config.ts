// src/runtime/config.ts
//
// 全局配置（~/.pi/agent/subagents/config.json）+ session 级状态（内存）。

import * as fs from "node:fs";
import * as path from "node:path";

import type {
  SessionModelState,
  SubagentsGlobalConfig,
} from "../types.ts";

// ============================================================
// 常量
// ============================================================

/** JSON 序列化缩进。 */
const JSON_INDENT = 2;

/** appendEntry 的 customType（restoreSessionState 据此匹配）。 */
const CONFIG_ENTRY_TYPE = "subagent-config-entry";

/** 默认配置。文件缺失/损坏时返回此值的深拷贝。 */
const DEFAULT_CONFIG: SubagentsGlobalConfig = {
  version: 1,
  yoloByDefault: false,
  maxConcurrent: 4,
  categories: {
    coding: { label: "编码", model: "deepseek-router/ds-flash", thinkingLevel: "high" },
    research: { label: "调研", model: "mimo-router/mimo-v2.5", thinkingLevel: "medium" },
    testing: { label: "测试", model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
    vision: { label: "视觉", model: "zhipu-coding-plan-router/glm-5.1", thinkingLevel: "xhigh" },
    planning: { label: "规划", model: "deepseek-router/ds-pro", thinkingLevel: "xhigh" },
    general: { label: "通用", model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
  },
  agentCategoryOverrides: { worker: "coding", reviewer: "coding", scout: "research" },
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

// ============================================================
// 路径
// ============================================================

/** 配置文件路径（~/.pi/agent/subagents/config.json）。 */
export function getGlobalConfigPath(homeDir: string): string {
  return path.join(homeDir, ".pi", "agent", "subagents", "config.json");
}

// ============================================================
// 全局配置加载/保存
// ============================================================

/** 默认配置的深拷贝（避免调用方 mutate DEFAULT_CONFIG 常量）。 */
function defaultConfig(): SubagentsGlobalConfig {
  return {
    ...DEFAULT_CONFIG,
    categories: { ...DEFAULT_CONFIG.categories },
    agentCategoryOverrides: { ...DEFAULT_CONFIG.agentCategoryOverrides },
    fallback: { ...DEFAULT_CONFIG.fallback },
  };
}

/** 校验 categories 最小结构（label + model 字符串），非法值回退默认。 */
function sanitizeCategories(input: unknown): SubagentsGlobalConfig["categories"] {
  const result = { ...DEFAULT_CONFIG.categories };
  if (!input || typeof input !== "object") return result;
  for (const [name, def] of Object.entries(input as Record<string, unknown>)) {
    if (!def || typeof def !== "object") continue;
    const d = def as Record<string, unknown>;
    if (typeof d.label !== "string" || typeof d.model !== "string") continue;
    result[name] = {
      label: d.label,
      model: d.model,
      thinkingLevel: typeof d.thinkingLevel === "string" ? d.thinkingLevel : undefined,
    };
  }
  return result;
}

/**
 * 加载全局配置。文件不存在时返回默认配置（保证 categories/fallback 完整）。
 * 与默认配置 deep-merge——新增字段有默认值，旧 config 缺字段不崩溃。
 */
export function loadGlobalConfig(homeDir: string): SubagentsGlobalConfig {
  const configPath = getGlobalConfigPath(homeDir);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubagentsGlobalConfig>;
    return {
      version: parsed.version ?? DEFAULT_CONFIG.version,
      yoloByDefault: parsed.yoloByDefault ?? DEFAULT_CONFIG.yoloByDefault,
      maxConcurrent: parsed.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
      categories: sanitizeCategories(parsed.categories),
      agentCategoryOverrides: { ...DEFAULT_CONFIG.agentCategoryOverrides, ...parsed.agentCategoryOverrides },
      fallback: { ...DEFAULT_CONFIG.fallback, ...parsed.fallback },
    };
  } catch {
    // 文件不存在 / JSON 解析失败 → 返回默认配置的深拷贝
    return defaultConfig();
  }
}

/** 保存全局配置（config-wizard 调用）。原子写入（temp + rename）。 */
export function saveGlobalConfig(homeDir: string, config: SubagentsGlobalConfig): Promise<void> {
  const configPath = getGlobalConfigPath(homeDir);
  const configDir = path.dirname(configPath);
  return new Promise((resolve, reject) => {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      const tempPath = `${configPath}.tmp.${process.pid}`;
      fs.writeFileSync(tempPath, `${JSON.stringify(config, null, JSON_INDENT)}\n`, "utf-8");
      fs.renameSync(tempPath, configPath);
      resolve();
    } catch (err) {
      reject(err);
    }
  });
}

// ============================================================
// Session 级状态（内存，可经 appendEntry 持久化/恢复）
// ============================================================

/**
 * 创建初始 session 状态（session_start 时调用）。
 *
 * categoryConfirmed 默认 true——不拦截执行（D-1：取消首次确认）。
 * 用户改 category 模型走 /subagents config（写 globalConfig）；感知模型靠 tool block
 * 醒目显示。categoryModels/agentModels 保留为 inert 字段（resolveModel 有兜底不崩）。
 */
export function createSessionState(): SessionModelState {
  return { yoloMode: false, categoryConfirmed: true, categoryModels: {}, agentModels: {} };
}

/**
 * 从 entries 恢复 session 状态（/resume 时）。
 * 倒序遍历——取最新一条 subagent-config-entry 快照（与仓库约定一致）。
 * 反序列化字段缺失时用默认值（向后兼容）。
 */
export function restoreSessionState(entries: ReadonlyArray<{ type: string; data?: unknown }>): SessionModelState {
  const state = createSessionState();
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== CONFIG_ENTRY_TYPE || !entry.data) continue;
    const d = entry.data as Partial<SessionModelState>;
    if (typeof d.yoloMode === "boolean") state.yoloMode = d.yoloMode;
    if (typeof d.categoryConfirmed === "boolean") state.categoryConfirmed = d.categoryConfirmed;
    if (d.categoryModels && typeof d.categoryModels === "object") {
      state.categoryModels = { ...d.categoryModels };
    }
    if (d.agentModels && typeof d.agentModels === "object") {
      state.agentModels = { ...d.agentModels };
    }
    break;
  }
  return state;
}
