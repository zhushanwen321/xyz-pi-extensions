// src/__tests__/session-file-gc.test.ts
//
// 锁定 maybeCleanupExpiredSessionFiles 的 TTL 边界（数据安全风险）：
//   - 概率门（CLEANUP_PROBABILITY = 1/20）
//   - TTL 边界（mtimeMs 恰好 = now - TTL_MS）
//   - 只删 .jsonl，不删 .txt 等
//   - 递归 walk 子目录
//   - best-effort 吞错（只读目录不外抛）
//
// 边界算错会误删未过期 session 文件或不清理——数据安全风险。
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as aliveStore from "../runtime/execution/alive-store.ts";
import { maybeCleanupExpiredSessionFiles } from "../runtime/session-file-gc.ts";

// ============================================================
// helpers
// ============================================================

let tmpAgentDir: string;

beforeEach(() => {
  tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-gc-test-"));
});

afterEach(() => {
  fs.rmSync(tmpAgentDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 强制 Math.random 返回 0（< CLEANUP_PROBABILITY → 必触发清理）。 */
function forceCleanupTrigger(): void {
  vi.spyOn(Math, "random").mockReturnValue(0);
}

/** 强制 Math.random 返回 1（>= CLEANUP_PROBABILITY → 跳过清理）。 */
function forceCleanupSkip(): void {
  vi.spyOn(Math, "random").mockReturnValue(1);
}

/** 创建一个 .jsonl 文件，mtime 设为指定天数前。 */
function createSessionFile(relPath: string, daysAgo: number): string {
  const fullPath = path.join(tmpAgentDir, "subagents", relPath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, `{"id":"${relPath}"}\n`, "utf-8");
  // 设置 mtime：daysAgo 天前
  const targetTime = Date.now() / 1000 - daysAgo * 86400;
  fs.utimesSync(fullPath, targetTime, targetTime);
  return fullPath;
}

// ============================================================
// maybeCleanupExpiredSessionFiles
// ============================================================

describe("maybeCleanupExpiredSessionFiles", () => {
  it("skips cleanup when random >= CLEANUP_PROBABILITY (probability gate)", () => {
    forceCleanupSkip();
    const oldFile = createSessionFile("old.jsonl", 31); // 31 天前，超 TTL
    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");
    // 概率门跳过 → 文件仍在
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  it("triggers cleanup when random < CLEANUP_PROBABILITY", () => {
    forceCleanupTrigger();
    const oldFile = createSessionFile("old.jsonl", 31);
    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");
    expect(fs.existsSync(oldFile)).toBe(false);
  });

  it("deletes files older than 30 days (TTL)", () => {
    forceCleanupTrigger();
    const old = createSessionFile("old.jsonl", 31);
    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");
    expect(fs.existsSync(old)).toBe(false);
  });

  it("preserves files younger than 30 days", () => {
    forceCleanupTrigger();
    const young = createSessionFile("young.jsonl", 29);
    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");
    expect(fs.existsSync(young)).toBe(true);
  });

  it("does NOT delete non-.jsonl files even if old (e.g. .txt)", () => {
    forceCleanupTrigger();
    const oldTxt = createSessionFile("old.txt", 31);
    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");
    // .txt 不在清理范围
    expect(fs.existsSync(oldTxt)).toBe(true);
  });

  it("recursively walks subdirectories", () => {
    forceCleanupTrigger();
    // 子目录中的旧文件
    const oldNested = createSessionFile(
      path.join("encoded-cwd-1", "sessions", "sess-old.jsonl"),
      31,
    );
    const youngNested = createSessionFile(
      path.join("encoded-cwd-1", "sessions", "sess-young.jsonl"),
      5,
    );
    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");
    expect(fs.existsSync(oldNested)).toBe(false);
    expect(fs.existsSync(youngNested)).toBe(true);
  });

  it("no-op when subagents dir does not exist (no throw)", () => {
    forceCleanupTrigger();
    // tmpAgentDir 下没有 subagents/ 目录
    expect(() => maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd")).not.toThrow();
  });

  it("best-effort: never throws when 'subagents' is a file not a dir (readdirSync ENOTDIR)", () => {
    // ESM 不允许 spyOn 命名空间导出，改用真实错误场景：
    // 创建一个名为 subagents 的普通文件（非目录），existsSync 返 true 但 readdirSync 抛 ENOTDIR
    forceCleanupTrigger();
    const fileNotDir = path.join(tmpAgentDir, "subagents");
    fs.writeFileSync(fileNotDir, "not a directory", "utf-8");
    // walkAndClean 内部 readdirSync 抛错 → 被其 try/catch 吞掉 → 不外抛
    expect(() => maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd")).not.toThrow();
  });

  it("TTL boundary: file just under 30 days is NOT deleted (strict greater-than semantics)", () => {
    // walkAndClean 条件: now - stat.mtimeMs > TTL_MS（严格大于）
    // 设 mtime 为 30 天前减去 2 分钟 → now - mtimeMs = TTL_MS - 2min + ε < TTL_MS → 保留
    // 用 2 分钟缓冲消除「设 mtime 与 Date.now() 调用之间的几 ms 时间差」造成的抖动
    forceCleanupTrigger();
    const boundary = createSessionFile("boundary.jsonl", 0);
    // 覆盖 mtime 为「30 天 - 2 分钟」前
    const targetTime = Date.now() / 1000 - (30 * 86400 - 120);
    fs.utimesSync(boundary, targetTime, targetTime);
    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");
    // 严格 < TTL_MS → 不删（边界保留）
    expect(fs.existsSync(boundary)).toBe(true);
  });

  it("handles empty subagents dir (no files, no throw)", () => {
    forceCleanupTrigger();
    // 创建空 subagents 目录
    fs.mkdirSync(path.join(tmpAgentDir, "subagents"), { recursive: true });
    expect(() => maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd")).not.toThrow();
  });

  // ---- .finalized sidecar 清理 ----

  it("deletes .finalized sidecar along with expired .jsonl", () => {
    forceCleanupTrigger();
    const jsonl = createSessionFile("sess-finalized.jsonl", 31);
    const finalized = `${jsonl}.finalized`;
    fs.writeFileSync(finalized, "", "utf-8");
    const targetTime = Date.now() / 1000 - 31 * 86400;
    fs.utimesSync(finalized, targetTime, targetTime);

    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");

    expect(fs.existsSync(jsonl)).toBe(false);
    expect(fs.existsSync(finalized)).toBe(false);
  });

  it("cleans orphan .finalized sidecar when .jsonl already gone", () => {
    forceCleanupTrigger();
    const subagentsDir = path.join(tmpAgentDir, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    const orphan = path.join(subagentsDir, "dead-session.jsonl.finalized");
    fs.writeFileSync(orphan, "", "utf-8");
    const targetTime = Date.now() / 1000 - 31 * 86400;
    fs.utimesSync(orphan, targetTime, targetTime);

    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");

    expect(fs.existsSync(orphan)).toBe(false);
  });

  // ---- .alive sidecar + pid 探活 ----

  it("preserves expired .jsonl when .alive sidecar indicates live process (D-024)", () => {
    forceCleanupTrigger();
    const jsonl = createSessionFile("sess-alive.jsonl", 31);
    const alivePath = `${jsonl}.alive`;
    fs.writeFileSync(alivePath, JSON.stringify({ pid: 1, id: "s1", startedAt: Date.now() }), "utf-8");

    vi.spyOn(aliveStore, "readAliveMarker").mockReturnValue({ pid: 1, id: "s1", startedAt: Date.now() });
    vi.spyOn(aliveStore, "isProcessAlive").mockReturnValue(true);

    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");

    expect(fs.existsSync(jsonl)).toBe(true);
    expect(fs.existsSync(alivePath)).toBe(true);
  });

  it("deletes expired .jsonl + .alive when process is dead", () => {
    forceCleanupTrigger();
    const jsonl = createSessionFile("sess-dead.jsonl", 31);
    const alivePath = `${jsonl}.alive`;
    fs.writeFileSync(alivePath, JSON.stringify({ pid: 99999, id: "s2", startedAt: Date.now() }), "utf-8");

    vi.spyOn(aliveStore, "readAliveMarker").mockReturnValue({ pid: 99999, id: "s2", startedAt: Date.now() });
    vi.spyOn(aliveStore, "isProcessAlive").mockReturnValue(false);

    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");

    expect(fs.existsSync(jsonl)).toBe(false);
    expect(fs.existsSync(alivePath)).toBe(false);
  });

  it("cleans orphan .alive sidecar when .jsonl already gone", () => {
    forceCleanupTrigger();
    const subagentsDir = path.join(tmpAgentDir, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    const orphan = path.join(subagentsDir, "dead-session.jsonl.alive");
    fs.writeFileSync(orphan, JSON.stringify({ pid: 99999, id: "s3", startedAt: Date.now() }), "utf-8");
    const targetTime = Date.now() / 1000 - 31 * 86400;
    fs.utimesSync(orphan, targetTime, targetTime);

    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");

    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("deletes .jsonl + all sidecars (.cancelled, .finalized, .alive) together", () => {
    forceCleanupTrigger();
    const jsonl = createSessionFile("sess-all-sidecars.jsonl", 31);
    const cancelled = `${jsonl}.cancelled`;
    const finalized = `${jsonl}.finalized`;
    const alive = `${jsonl}.alive`;
    fs.writeFileSync(cancelled, "", "utf-8");
    fs.writeFileSync(finalized, "", "utf-8");
    fs.writeFileSync(alive, JSON.stringify({ pid: 99999, id: "s4", startedAt: Date.now() }), "utf-8");

    vi.spyOn(aliveStore, "readAliveMarker").mockReturnValue({ pid: 99999, id: "s4", startedAt: Date.now() });
    vi.spyOn(aliveStore, "isProcessAlive").mockReturnValue(false);

    maybeCleanupExpiredSessionFiles(tmpAgentDir, "/cwd");

    expect(fs.existsSync(jsonl)).toBe(false);
    expect(fs.existsSync(cancelled)).toBe(false);
    expect(fs.existsSync(finalized)).toBe(false);
    expect(fs.existsSync(alive)).toBe(false);
  });
});
