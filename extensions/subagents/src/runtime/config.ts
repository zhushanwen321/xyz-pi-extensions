// src/runtime/config.ts
//
// 全局配置（~/.pi/agent/subagents/config.json）+ session 级状态（内存）。
//
// 默认配置的单一真相源是扩展自带的 config.json（与 src/ 同级）。代码不硬编码
// category models——避免代码默认值与磁盘 config.json 分叉。

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * 扩展自带的默认配置（config.json，与 src/ 同级）。
 * 单一真相源：代码默认值与磁盘 config.json 永远一致。
 * 懒加载（首次访问时读一次），读失败回退到硬编码最小默认（保证永不崩溃）。
 */
const BUILTIN_CONFIG_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "config.json",
);

let _builtinConfigCache: SubagentsGlobalConfig | undefined;

function loadBuiltinConfig(): SubagentsGlobalConfig {
  if (_builtinConfigCache) return _builtinConfigCache;
  try {
    const raw = fs.readFileSync(BUILTIN_CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubagentsGlobalConfig>;
    _builtinConfigCache = {
      version: parsed.version ?? 1,
      yoloByDefault: parsed.yoloByDefault ?? false,
      maxConcurrent: parsed.maxConcurrent ?? 4,
      categories: (parsed.categories as SubagentsGlobalConfig["categories"]) ?? {},
      agentCategoryOverrides: (parsed.agentCategoryOverrides as SubagentsGlobalConfig["agentCategoryOverrides"]) ?? {},
      fallback: (parsed.fallback as SubagentsGlobalConfig["fallback"]) ?? { model: "", thinkingLevel: undefined },
    };
  } catch {
    // config.json 读失败（打包遗漏 / 损坏）→ 最小硬编码默认，保证不崩
    _builtinConfigCache = {
      version: 1,
      yoloByDefault: false,
      maxConcurrent: 4,
      categories: {},
      agentCategoryOverrides: {},
      fallback: { model: "", thinkingLevel: undefined },
    };
  }
  return _builtinConfigCache;
}

/** 默认配置（读自扩展自带 config.json）。 */
const DEFAULT_CONFIG: SubagentsGlobalConfig = loadBuiltinConfig();

// ============================================================
// 路径
// ============================================================

/**
 * 配置文件路径（<agentDir>/subagents/config.json）。
 * agentDir 由 Pi 核心 getAgentDir() 决定（读 PI_CODING_AGENT_DIR，默认 ~/.pi/agent），
 * 与 Pi 主进程的目录约定完全一致——支持宿主经环境变量整体重定向。
 */
export function getGlobalConfigPath(agentDir: string): string {
  return path.join(agentDir, "subagents", "config.json");
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
export function loadGlobalConfig(agentDir: string): SubagentsGlobalConfig {
  const configPath = getGlobalConfigPath(agentDir);
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
export function saveGlobalConfig(agentDir: string, config: SubagentsGlobalConfig): Promise<void> {
  const configPath = getGlobalConfigPath(agentDir);
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
