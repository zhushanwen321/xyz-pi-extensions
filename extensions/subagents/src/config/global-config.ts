// src/config/global-config.ts
import * as fs from "node:fs";
import type { SubagentsGlobalConfig } from "../types.ts";
import { DEFAULT_CATEGORIES } from "../category.ts";
import { getConfigDir, getConfigPath } from "./config-path.ts";

const DEFAULT_CONFIG: SubagentsGlobalConfig = {
  version: 1,
  yoloByDefault: false,
  maxConcurrent: 4,
  categories: { ...DEFAULT_CATEGORIES },
  agentCategoryOverrides: { worker: "coding", reviewer: "coding", scout: "research" },
  fallback: { model: "mimo-router/mimo-v2.5", thinkingLevel: "low" },
};

/** FR-4.6.3: 加载配置，缺失字段用默认值填充。文件不存在返回全默认。 */
export function loadGlobalConfig(homeDir: string): SubagentsGlobalConfig {
  const configPath = getConfigPath(homeDir);
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Partial<SubagentsGlobalConfig>;
    return {
      version: parsed.version ?? DEFAULT_CONFIG.version,
      yoloByDefault: parsed.yoloByDefault ?? DEFAULT_CONFIG.yoloByDefault,
      maxConcurrent: parsed.maxConcurrent ?? DEFAULT_CONFIG.maxConcurrent,
      categories: { ...DEFAULT_CONFIG.categories, ...parsed.categories },
      agentCategoryOverrides: { ...DEFAULT_CONFIG.agentCategoryOverrides, ...parsed.agentCategoryOverrides },
      fallback: { ...DEFAULT_CONFIG.fallback, ...parsed.fallback },
    };
  } catch {
    // 文件不存在或 JSON 解析失败 → 返回默认配置的深拷贝
    return {
      ...DEFAULT_CONFIG,
      categories: { ...DEFAULT_CONFIG.categories },
      agentCategoryOverrides: { ...DEFAULT_CONFIG.agentCategoryOverrides },
      fallback: { ...DEFAULT_CONFIG.fallback },
    };
  }
}

// FR-4.6.4: 串行化写队列，防止并发写入覆盖。
// 使用 const 对象持有（避免模块级 let 触发 check-structure 规则 5）
const _writeSlot: { chain: Promise<void> } = { chain: Promise.resolve() };

/** FR-4.6.4: 原子写入（temp + rename）+ 进程内串行化 */
export function saveGlobalConfig(homeDir: string, config: SubagentsGlobalConfig): Promise<void> {
  const configPath = getConfigPath(homeDir);
  const configDir = getConfigDir(homeDir);

  const actualWrite = (): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(configDir, { recursive: true });
        const tempPath = configPath + ".tmp." + process.pid;
        fs.writeFileSync(tempPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        fs.renameSync(tempPath, configPath);
        resolve();
      } catch (err) {
        reject(err);
      }
    });

  _writeSlot.chain = _writeSlot.chain.then(actualWrite, actualWrite);
  return _writeSlot.chain;
}
