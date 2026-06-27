/**
 * config.ts — 配置读取 + 校验 + 深合并默认值（Config 层）
 *
 * 变化轴：配置格式/校验规则。被 index.ts import（不依赖 engine，②AC-3）。
 * [骨架] ③#2 方案 A + ②§6 Config 层 + spec FR-1.1/FR-6/AC-2.1~2.7。
 * CA-7：loadConfig 解包顶层 key `system-prompt-loader` + 结构校验；deepMerge 是内部调用。
 */
import * as fs from "node:fs";

import type { ConfigSource, LoaderConfig, ValidateResult } from "./types.ts";
import { kindRankOf } from "./types.ts";

/**
 * 读 config.json → 解包顶层 key → 结构校验 → deepMerge 默认值。
 * 流程：readFileSync(ENOENT→空配置零副作用) → JSON.parse(失败→throw 交上层 notify+降级)
 *       → 解包 parsed["system-prompt-loader"](key 缺失→空配置) → 结构校验(sources 非数组→空配置)
 *       → 内部 deepMerge 补默认（sources 缺→[]，AC-2.4）。
 * [adapter 真引SDK] readFileSync + JSON.parse。
 */
export function loadConfig(configPath: string): LoaderConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch {
    // ENOENT/EACCES → 空配置（零副作用，不警告，AC-2.3）
    return { sources: [] };
  }
  // JSON 解析失败 → throw（交上层 notify+降级空配置，AC-2.1）
  const parsed: unknown = JSON.parse(raw);
  // 解包顶层 key（spec FR-1.1：{ "system-prompt-loader": { sources: [...] } }）
  return deepMerge(parsed);
}

/**
 * deepMerge：把解包后的 `system-prompt-loader` value 补默认。
 * sources 缺/非数组 → []（AC-2.4）。loadConfig 内部调用，不在时序图独立出现（CA-9）。
 * [叶子] 纯默认值合并，方法体属实现。
 */
function deepMerge(raw: unknown): LoaderConfig {
  if (
    raw &&
    typeof raw === "object" &&
    "system-prompt-loader" in raw &&
    raw["system-prompt-loader"] &&
    typeof raw["system-prompt-loader"] === "object"
  ) {
    const inner = (raw as Record<string, unknown>)["system-prompt-loader"] as Record<
      string,
      unknown
    >;
    if (Array.isArray(inner.sources)) {
      return { sources: inner.sources as ConfigSource[] };
    }
  }
  // 顶层 key 缺失 / sources 非数组 / 结构错误 → 空配置（FR-6 降级）
  return { sources: [] };
}

/**
 * 逐条校验 source。判别联合穷尽 switch——漏 case 报编译错（TS 兜底，#1 方案 A 价值）。
 * 未知 kind/缺必填字段/类型错误 → {ok:false,reason}（含 source 索引供 index notify "source #N"）。
 * OK → {ok:true}。返回值类型让 index 无需 try/catch 即分流（#2 方案 A）。
 * [模块内直调] switch(kind) 穷尽。
 */
export function validateSource(
  source: unknown,
  index: number,
): ValidateResult {
  if (!source || typeof source !== "object") {
    return { ok: false, reason: `source #${index}: not an object` };
  }
  const s = source as Record<string, unknown>;
  switch (s.kind) {
    case "explicit":
      if (typeof s.path !== "string" || !s.path) {
        return {
          ok: false,
          reason: `source #${index}: explicit missing required string 'path'`,
        };
      }
      return { ok: true };
    case "walk-files":
      if (!Array.isArray(s.filenames) || s.filenames.length === 0) {
        return {
          ok: false,
          reason: `source #${index}: walk-files missing required non-empty 'filenames'`,
        };
      }
      return { ok: true };
    case "walk-dirs":
      if (!Array.isArray(s.dirnames) || s.dirnames.length === 0) {
        return {
          ok: false,
          reason: `source #${index}: walk-dirs missing required non-empty 'dirnames'`,
        };
      }
      return { ok: true };
    case "glob":
      if (!Array.isArray(s.patterns) || s.patterns.length === 0) {
        return {
          ok: false,
          reason: `source #${index}: glob missing required non-empty 'patterns'`,
        };
      }
      return { ok: true };
    default:
      return {
        ok: false,
        reason: `source #${index}: unknown kind '${String(s.kind)}'`,
      };
  }
}

/** kindRank 导出（供 index 构造 sourceMeta，FR-3.1）。透传 types.kindRankOf。 */
export { kindRankOf };
