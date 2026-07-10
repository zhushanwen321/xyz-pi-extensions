// src/__tests__/config.test.ts
//
// loadGlobalConfig 测试。
// 配置已退化为仅 maxConcurrent（模型解析改为「主 agent model 优先」，
// 不再有 categories/fallback/yolo/session 级覆盖）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getGlobalConfigPath, loadGlobalConfig } from "../config.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-config-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写入 config.json（自动创建 subagents/ 子目录）。 */
function writeConfig(agentDir: string, content: string): void {
  const configPath = getGlobalConfigPath(agentDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content, "utf-8");
}

// ============================================================
// loadGlobalConfig
// ============================================================

describe("loadGlobalConfig", () => {
  it("returns default config when file does not exist", () => {
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1);
    expect(cfg.maxConcurrent).toBe(4);
  });

  it("returns default config when JSON is corrupt", () => {
    writeConfig(tmpDir, "{not valid json");
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1);
    expect(cfg.maxConcurrent).toBe(4);
  });

  it("deep-merges with defaults: missing fields fall back to defaults", () => {
    writeConfig(tmpDir, JSON.stringify({ version: 1 }));
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1);
    expect(cfg.maxConcurrent).toBe(4);
  });

  it("loads valid config with maxConcurrent override", () => {
    writeConfig(tmpDir, JSON.stringify({ version: 1, maxConcurrent: 8 }));
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.maxConcurrent).toBe(8);
  });

  it("ignores legacy categories/fallback/yoloByDefault fields (model resolution deprecated)", () => {
    // 旧 config.json 仍可能含这些字段——读取时不报错，但 SubagentsGlobalConfig
    // 类型上已不含它们，loadGlobalConfig 只取 version + maxConcurrent。
    writeConfig(
      tmpDir,
      JSON.stringify({
        version: 1,
        maxConcurrent: 6,
        yoloByDefault: true,
        categories: { coding: { label: "C", model: "x/y" } },
        fallback: { model: "anthropic/x" },
      }),
    );
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.maxConcurrent).toBe(6);
    expect(cfg.version).toBe(1);
    // 仅两个字段（类型保证）
    expect(Object.keys(cfg).sort()).toEqual(["maxConcurrent", "version"]);
  });
});

// ============================================================
// sanitizeMaxConcurrent（经 loadGlobalConfig 间接覆盖）
// ============================================================

describe("sanitizeMaxConcurrent (via loadGlobalConfig)", () => {
  it("rejects non-number maxConcurrent → default", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: "eight" }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(4);
  });

  it("rejects non-integer maxConcurrent → default", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: 4.5 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(4);
  });

  it("rejects zero/negative maxConcurrent → default", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: 0 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(4);
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: -1 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(4);
  });

  it("accepts positive integer", () => {
    writeConfig(tmpDir, JSON.stringify({ maxConcurrent: 16 }));
    expect(loadGlobalConfig(tmpDir).maxConcurrent).toBe(16);
  });
});
