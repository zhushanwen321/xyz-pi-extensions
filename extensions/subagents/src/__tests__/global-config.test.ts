// src/__tests__/global-config.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach,beforeEach, describe, expect, it } from "vitest";

import { loadGlobalConfig, saveGlobalConfig } from "../config/global-config.ts";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-test-"));
});
afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("loadGlobalConfig", () => {
  it("returns defaults when file missing", () => {
    const cfg = loadGlobalConfig(tempDir);
    expect(cfg.version).toBe(1);
    expect(cfg.yoloByDefault).toBe(false);
    expect(cfg.maxConcurrent).toBe(4);
    expect(cfg.categories.coding.model).toBe("deepseek-router/ds-flash");
    expect(cfg.fallback.model).toBe("mimo-router/mimo-v2.5");
  });

  it("merges user config over defaults (partial)", () => {
    const dir = path.join(tempDir, ".pi", "agent", "extensions", "subagents");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      version: 1, maxConcurrent: 8,
    }));
    const cfg = loadGlobalConfig(tempDir);
    expect(cfg.maxConcurrent).toBe(8);       // 用户覆盖
    expect(cfg.yoloByDefault).toBe(false);   // 默认保留
    expect(cfg.categories.research.model).toBe("mimo-router/mimo-v2.5"); // 默认 category 保留
  });

  it("Round 4 S14: corrupted JSON returns defaults without throwing", () => {
    const dir = path.join(tempDir, ".pi", "agent", "extensions", "subagents");
    fs.mkdirSync(dir, { recursive: true });
    // 故意写损坏的 JSON
    fs.writeFileSync(path.join(dir, "config.json"), "{ invalid json ::");
    // 不应抛错，应返回默认配置
    const cfg = loadGlobalConfig(tempDir);
    expect(cfg.version).toBe(1);
    expect(cfg.maxConcurrent).toBe(4);
    expect(cfg.yoloByDefault).toBe(false);
  });
});

describe("saveGlobalConfig", () => {
  it("writes config and reloads same data", async () => {
    const cfg = loadGlobalConfig(tempDir);
    cfg.yoloByDefault = true;
    await saveGlobalConfig(tempDir, cfg);
    const reloaded = loadGlobalConfig(tempDir);
    expect(reloaded.yoloByDefault).toBe(true);
  });
});
