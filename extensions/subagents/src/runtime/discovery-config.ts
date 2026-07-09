// src/runtime/discovery-config.ts
//
// 资源发现契约（<agentDir>/subagents/discovery.json）。
//
// 宿主（xyz-agent GUI 等）启动 pi 前写入本文件，声明要加载的 skill 目录与
// agent 目录（按覆盖顺序排列）。subagents 在 session_start 与 resources_discover
// 时读取，主 agent 与子 session 的资源注入都以此文件为单一真相源。
// 文件缺失或字段非法时，skillDirs/agentDirs 视为空数组，走默认行为（零破坏）。
//
// 详见 ADR-028。

import * as fs from "node:fs";
import * as path from "node:path";

import type { DiscoveryConfig } from "../types.ts";

// ============================================================
// 常量与默认值
// ============================================================

/** discovery.json 的当前版本。字段结构变更时递增。 */
const DISCOVERY_VERSION = 1;

/** 空契约（文件缺失/解析失败时返回，保证调用方拿到统一形状）。 */
const EMPTY_DISCOVERY: DiscoveryConfig = {
  version: DISCOVERY_VERSION,
  skillDirs: [],
  agentDirs: [],
};

// ============================================================
// 路径
// ============================================================

/**
 * discovery.json 路径（<agentDir>/subagents/discovery.json）。
 * 与 config.json 同级，落在 subagents 专属子目录下。
 */
export function getDiscoveryConfigPath(agentDir: string): string {
  return path.join(agentDir, "subagents", "discovery.json");
}

// ============================================================
// 加载与校验
// ============================================================

/**
 * 从字符串数组字段中提取合法的绝对路径条目。
 * 去重（保序，靠前优先）、剔除非字符串/空串。
 */
function sanitizePathList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    if (typeof item !== "string" || item.length === 0) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}

/**
 * 解析 discovery.json 原始内容为 DiscoveryConfig。
 * 宽容解析：任何字段非法都回退到空数组，不抛错（best-effort，不阻断 session）。
 */
function parseDiscoveryConfig(raw: string): DiscoveryConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...EMPTY_DISCOVERY };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { ...EMPTY_DISCOVERY };
  }
  const obj = parsed as Record<string, unknown>;
  return {
    version: typeof obj.version === "number" ? obj.version : DISCOVERY_VERSION,
    skillDirs: sanitizePathList(obj.skillDirs),
    agentDirs: sanitizePathList(obj.agentDirs),
  };
}

// ============================================================
// mtime 缓存加载器
// ============================================================

/**
 * 带 mtime 缓存的 discovery.json 读取器。
 *
 * discovery.json 在一次 session 内被读取两次（resources_discover + session-runner），
 * 用 mtime 判断是否需要重新 read+parse，避免重复磁盘 IO。
 *
 * 跨 session 复用：mtime 变了才重读。宿主写文件时用原子写（temp + rename），
 * mtime 会变化，触发下次读取重新解析。
 */
export class DiscoveryConfigLoader {
  private cached: DiscoveryConfig | null = null;
  private cachedMtimeMs: number | null = null;
  private readonly filePath: string;

  constructor(agentDir: string) {
    this.filePath = getDiscoveryConfigPath(agentDir);
  }

  /**
   * 读取 discovery.json（mtime 未变则复用缓存）。
   * 文件不存在/不可读/解析失败均返回空契约，永不抛错。
   */
  load(): DiscoveryConfig {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.filePath);
    } catch {
      // 文件不存在 / 不可 stat → 清缓存返回空（宿主可能删了文件）
      this.cached = null;
      this.cachedMtimeMs = null;
      return { ...EMPTY_DISCOVERY };
    }
    const mtimeMs = stat.mtimeMs;
    if (this.cached !== null && this.cachedMtimeMs === mtimeMs) {
      return this.cached;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.cached = parseDiscoveryConfig(raw);
      this.cachedMtimeMs = mtimeMs;
      return this.cached;
    } catch {
      return { ...EMPTY_DISCOVERY };
    }
  }
}
