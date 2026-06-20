// src/__tests__/config.test.ts
//
// 锁定 config.ts 的三个关键函数：
//   - loadGlobalConfig（文件缺失 / JSON 解析失败 → 默认；deep-merge 默认值）
//   - sanitizeCategories（label/model 类型校验 + 非法值回退）
//   - restoreSessionState（倒序取最新 entry + 字段缺失向后兼容）
//
// restoreSessionState 正是 review 指南「反序列化字段缺失给默认值」典型必测项。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createSessionState,
  getGlobalConfigPath,
  loadGlobalConfig,
  restoreSessionState,
} from "../runtime/config/config.ts";
import type { SessionModelState } from "../types.ts";

// ============================================================
// helpers
// ============================================================

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
    expect(cfg.yoloByDefault).toBe(false);
    expect(cfg.maxConcurrent).toBe(4);
    expect(cfg.fallback.model).toBe("anthropic/claude-sonnet-4-5");
    expect(cfg.categories).toEqual({});
    expect(cfg.agentCategoryOverrides).toEqual({});
  });

  it("returns default config when JSON is corrupt", () => {
    writeConfig(tmpDir, "{not valid json");
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1); // 默认值兜底
    expect(cfg.maxConcurrent).toBe(4);
  });

  it("deep-merges with defaults: missing fields fall back to defaults", () => {
    // 只给 version，其余字段缺失
    writeConfig(tmpDir, JSON.stringify({ version: 1 }));
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.version).toBe(1);
    expect(cfg.yoloByDefault).toBe(false); // 默认
    expect(cfg.maxConcurrent).toBe(4); // 默认
    expect(cfg.categories).toEqual({}); // 默认空对象
    expect(cfg.fallback.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("loads valid config with overrides", () => {
    writeConfig(
      tmpDir,
      JSON.stringify({
        version: 1,
        yoloByDefault: true,
        maxConcurrent: 8,
        fallback: { model: "openai/gpt-4" },
        categories: {
          coding: { label: "Coding", model: "anthropic/claude-sonnet-4-5" },
        },
        agentCategoryOverrides: { worker: "coding" },
      }),
    );
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.yoloByDefault).toBe(true);
    expect(cfg.maxConcurrent).toBe(8);
    expect(cfg.fallback.model).toBe("openai/gpt-4");
    expect(cfg.categories.coding).toEqual({
      label: "Coding",
      model: "anthropic/claude-sonnet-4-5",
      thinkingLevel: undefined,
    });
    expect(cfg.agentCategoryOverrides.worker).toBe("coding");
  });

  it("partial fallback: only model overridden, thinkingLevel falls back to undefined", () => {
    writeConfig(tmpDir, JSON.stringify({ fallback: { model: "x/y" } }));
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.fallback.model).toBe("x/y");
    expect(cfg.fallback.thinkingLevel).toBeUndefined();
  });
});

// ============================================================
// sanitizeCategories（经 loadGlobalConfig 间接覆盖）
// ============================================================

describe("sanitizeCategories (via loadGlobalConfig)", () => {
  it("rejects category entry missing label or model", () => {
    writeConfig(
      tmpDir,
      JSON.stringify({
        categories: {
          valid: { label: "V", model: "m1" },
          noLabel: { model: "m2" }, // 缺 label → 回退
          noModel: { label: "L" }, // 缺 model → 回退
          wrongTypes: { label: 123, model: true }, // 类型错 → 回退
        },
      }),
    );
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.categories.valid).toBeDefined();
    expect(cfg.categories.valid?.model).toBe("m1");
    expect(cfg.categories.noLabel).toBeUndefined();
    expect(cfg.categories.noModel).toBeUndefined();
    expect(cfg.categories.wrongTypes).toBeUndefined();
  });

  it("accepts optional thinkingLevel string, rejects non-string thinkingLevel", () => {
    writeConfig(
      tmpDir,
      JSON.stringify({
        categories: {
          withThinking: { label: "L", model: "m", thinkingLevel: "high" },
          badThinking: { label: "L2", model: "m2", thinkingLevel: 123 },
        },
      }),
    );
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.categories.withThinking?.thinkingLevel).toBe("high");
    // 非 string thinkingLevel 被忽略 → undefined
    expect(cfg.categories.badThinking?.thinkingLevel).toBeUndefined();
    // 但 label/model 仍有效
    expect(cfg.categories.badThinking?.model).toBe("m2");
  });

  it("rejects non-object categories value", () => {
    writeConfig(tmpDir, JSON.stringify({ categories: "not-an-object" }));
    const cfg = loadGlobalConfig(tmpDir);
    expect(cfg.categories).toEqual({}); // 完全回退默认
  });
});

// ============================================================
// restoreSessionState
// ============================================================

describe("restoreSessionState", () => {
  it("returns default state when entries is empty", () => {
    const state = restoreSessionState([]);
    const expected: SessionModelState = {
      yoloMode: false,
      categoryConfirmed: true,
      categoryModels: {},
      agentModels: {},
    };
    expect(state).toEqual(expected);
  });

  it("returns default state when no matching entry type", () => {
    const state = restoreSessionState([
      { type: "other-entry-type", data: { yoloMode: true } },
      { type: "another-type" },
    ]);
    expect(state.yoloMode).toBe(false); // 未匹配 → 默认
    expect(state.categoryConfirmed).toBe(true);
  });

  it("restores from the latest matching entry (reverse iteration)", () => {
    // 三条同类型 entry，应取最后一条（倒序遍历命中的第一个）
    const state = restoreSessionState([
      { type: "subagent-config-entry", data: { yoloMode: false, categoryConfirmed: true } },
      { type: "subagent-config-entry", data: { yoloMode: true, categoryConfirmed: false } },
      { type: "subagent-config-entry", data: { yoloMode: false, categoryConfirmed: false } },
    ]);
    // 最新（最后一条）：yoloMode=false, categoryConfirmed=false
    expect(state.yoloMode).toBe(false);
    expect(state.categoryConfirmed).toBe(false);
  });

  it("ignores matching entry with no data", () => {
    const state = restoreSessionState([
      { type: "subagent-config-entry" }, // 无 data → 跳过
    ]);
    expect(state.yoloMode).toBe(false);
  });

  it("backward compat: partial data with missing fields uses defaults", () => {
    // 旧 entry 只有 yoloMode，缺 categoryConfirmed/categoryModels/agentModels
    const state = restoreSessionState([
      { type: "subagent-config-entry", data: { yoloMode: true } },
    ]);
    expect(state.yoloMode).toBe(true);
    expect(state.categoryConfirmed).toBe(true); // 默认
    expect(state.categoryModels).toEqual({}); // 默认
    expect(state.agentModels).toEqual({}); // 默认
  });

  it("backward compat: wrong-type fields are ignored", () => {
    const state = restoreSessionState([
      {
        type: "subagent-config-entry",
        data: {
          yoloMode: "yes", // 非 boolean → 忽略
          categoryConfirmed: 1, // 非 boolean → 忽略
          categoryModels: "not-an-object", // 非 object → 忽略
          agentModels: null, // null → 忽略
        },
      },
    ]);
    expect(state.yoloMode).toBe(false);
    expect(state.categoryConfirmed).toBe(true);
    expect(state.categoryModels).toEqual({});
    expect(state.agentModels).toEqual({});
  });

  it("restores categoryModels and agentModels objects", () => {
    const state = restoreSessionState([
      {
        type: "subagent-config-entry",
        data: {
          categoryModels: { coding: { model: "m1" } },
          agentModels: { worker: { model: "m2", thinkingLevel: "high" } },
        },
      },
    ]);
    expect(state.categoryModels.coding).toEqual({ model: "m1" });
    expect(state.agentModels.worker).toEqual({ model: "m2", thinkingLevel: "high" });
  });
});

// ============================================================
// createSessionState
// ============================================================

describe("createSessionState", () => {
  it("returns default state with categoryConfirmed=true (no first-confirm gate)", () => {
    const state = createSessionState();
    expect(state.yoloMode).toBe(false);
    expect(state.categoryConfirmed).toBe(true);
    expect(state.categoryModels).toEqual({});
    expect(state.agentModels).toEqual({});
  });
});
