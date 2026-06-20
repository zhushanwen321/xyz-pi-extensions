// src/__tests__/discovery-config.test.ts
//
// 锁定 DiscoveryConfigLoader 的 mtime 缓存逻辑（缓存类经典 bug 源）：
//   - stat 失败（文件不存在）→ 清缓存返空契约
//   - mtime 不变 → 命中缓存
//   - mtime 变 → 重新读取解析
//   - read 失败 → 返空契约
//
// 以及 sanitizePathList（经 parseDiscoveryConfig 间接覆盖）：
//   - 去重保序、剔除非字符串/空串
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DiscoveryConfigLoader, getDiscoveryConfigPath } from "../runtime/discovery-config.ts";

// ============================================================
// helpers
// ============================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-discovery-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写入 discovery.json。 */
function writeDiscovery(agentDir: string, content: string): void {
  const p = getDiscoveryConfigPath(agentDir);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

/** 设置文件 mtime 为指定时间戳（秒级，跨平台兼容）。 */
function setMtime(filePath: string, epochSeconds: number): void {
  const t = Math.floor(epochSeconds);
  // utimesSync(seconds, seconds) —— Node 接受秒级数字
  fs.utimesSync(filePath, t, t);
}

// ============================================================
// DiscoveryConfigLoader
// ============================================================

describe("DiscoveryConfigLoader", () => {
  it("returns empty contract when file does not exist", () => {
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    expect(cfg.skillDirs).toEqual([]);
    expect(cfg.agentDirs).toEqual([]);
    expect(cfg.version).toBe(1);
  });

  it("reads and parses a valid config", () => {
    writeDiscovery(
      tmpDir,
      JSON.stringify({
        version: 1,
        skillDirs: ["/a/skills", "/b/skills"],
        agentDirs: ["/a/agents"],
      }),
    );
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    expect(cfg.skillDirs).toEqual(["/a/skills", "/b/skills"]);
    expect(cfg.agentDirs).toEqual(["/a/agents"]);
    expect(cfg.version).toBe(1);
  });

  it("caches: same mtime → no re-read (returns same reference)", () => {
    writeDiscovery(
      tmpDir,
      JSON.stringify({ skillDirs: ["/v1"], agentDirs: [] }),
    );
    const loader = new DiscoveryConfigLoader(tmpDir);
    const first = loader.load();
    const second = loader.load();
    // 同一 mtime → 命中缓存（应返回同一引用）
    expect(second).toBe(first);
  });

  it("invalidates cache when mtime changes → re-reads new content", () => {
    writeDiscovery(
      tmpDir,
      JSON.stringify({ skillDirs: ["/v1"], agentDirs: [] }),
    );
    const loader = new DiscoveryConfigLoader(tmpDir);
    const first = loader.load();
    expect(first.skillDirs).toEqual(["/v1"]);

    // 修改文件内容 + 推进 mtime
    const newPath = getDiscoveryConfigPath(tmpDir);
    fs.writeFileSync(newPath, JSON.stringify({ skillDirs: ["/v2"], agentDirs: [] }), "utf-8");
    // 推进 mtime（fs.writeFileSync 通常已更新 mtime，但同秒内可能相等——显式 +1 天确保变化）
    const stat = fs.statSync(newPath);
    setMtime(newPath, stat.mtimeMs / 1000 + 86400);

    const second = loader.load();
    // mtime 变化 → 重新读取
    expect(second).not.toBe(first); // 新引用
    expect(second.skillDirs).toEqual(["/v2"]);
  });

  it("clears cache when file is deleted (stat fails)", () => {
    writeDiscovery(
      tmpDir,
      JSON.stringify({ skillDirs: ["/x"], agentDirs: [] }),
    );
    const loader = new DiscoveryConfigLoader(tmpDir);
    const first = loader.load();
    expect(first.skillDirs).toEqual(["/x"]);

    // 删除文件
    fs.unlinkSync(getDiscoveryConfigPath(tmpDir));
    const second = loader.load();
    expect(second.skillDirs).toEqual([]); // 空契约
    expect(second.agentDirs).toEqual([]);

    // 再次删除后重新创建 → 应重新读取（缓存已被清空）
    writeDiscovery(
      tmpDir,
      JSON.stringify({ skillDirs: ["/y"], agentDirs: ["/agents"] }),
    );
    const third = loader.load();
    expect(third.skillDirs).toEqual(["/y"]);
    expect(third.agentDirs).toEqual(["/agents"]);
  });

  it("returns empty contract on corrupt JSON", () => {
    writeDiscovery(tmpDir, "{ not valid json");
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    expect(cfg.skillDirs).toEqual([]);
    expect(cfg.agentDirs).toEqual([]);
    expect(cfg.version).toBe(1); // 默认 version
  });

  it("returns empty contract when root is not an object", () => {
    writeDiscovery(tmpDir, JSON.stringify(["not", "an", "object"]));
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    expect(cfg.skillDirs).toEqual([]);
    expect(cfg.agentDirs).toEqual([]);
  });
});

// ============================================================
// sanitizePathList（经 parseDiscoveryConfig 间接覆盖）
// ============================================================

describe("sanitizePathList (via parseDiscoveryConfig)", () => {
  it("removes duplicates while preserving first-occurrence order", () => {
    writeDiscovery(
      tmpDir,
      JSON.stringify({
        skillDirs: ["/a", "/b", "/a", "/c", "/b"],
      }),
    );
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    expect(cfg.skillDirs).toEqual(["/a", "/b", "/c"]);
  });

  it("filters out non-string and empty-string entries", () => {
    writeDiscovery(
      tmpDir,
      JSON.stringify({
        skillDirs: ["/valid", 123, null, "", "  ", false, { x: 1 }, "/valid2"],
      }),
    );
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    // 只保留非空字符串：/valid, "  "(非空字符串保留), /valid2
    // 注意：sanitizePathList 只剔除非字符串和空串，"  " 是非空字符串所以保留
    expect(cfg.skillDirs).toEqual(["/valid", "  ", "/valid2"]);
  });

  it("returns empty array when skillDirs is not an array", () => {
    writeDiscovery(
      tmpDir,
      JSON.stringify({
        skillDirs: "not-an-array",
        agentDirs: { key: "value" },
      }),
    );
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    expect(cfg.skillDirs).toEqual([]);
    expect(cfg.agentDirs).toEqual([]);
  });

  it("default version is 1 when version is missing or wrong type", () => {
    writeDiscovery(tmpDir, JSON.stringify({ skillDirs: [], agentDirs: [] })); // 无 version
    const loader = new DiscoveryConfigLoader(tmpDir);
    const cfg = loader.load();
    expect(cfg.version).toBe(1);

    writeDiscovery(
      tmpDir,
      JSON.stringify({ version: "two", skillDirs: [], agentDirs: [] }),
    );
    const loader2 = new DiscoveryConfigLoader(tmpDir);
    const cfg2 = loader2.load();
    expect(cfg2.version).toBe(1); // 非 number → 默认
  });
});

// ============================================================
// getDiscoveryConfigPath
// ============================================================

describe("getDiscoveryConfigPath", () => {
  it("joins agentDir/subagents/discovery.json", () => {
    expect(getDiscoveryConfigPath("/home/u/.pi/agent")).toBe(
      "/home/u/.pi/agent/subagents/discovery.json",
    );
  });
});
