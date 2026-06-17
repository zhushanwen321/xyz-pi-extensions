// src/__tests__/session-file-gc.test.ts
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getSessionsDir } from "../config/config-path.ts";
import { cleanupExpiredSessionFiles, maybeCleanupExpiredSessionFiles } from "../persistence/session-file-gc.ts";
import { SESSION_FILE_TTL_DAYS } from "../types.ts";

let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "subagents-gc-test-"));
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function createSessionFile(homeDir: string, cwd: string, name: string, mtimeDaysAgo: number): string {
  const dir = getSessionsDir(homeDir, cwd);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, '{"role":"user"}\n', "utf-8");
  // 设置 mtime
  const targetTime = new Date(Date.now() - mtimeDaysAgo * 24 * 60 * 60 * 1000);
  fs.utimesSync(filePath, targetTime, targetTime);
  return filePath;
}

describe("session-file-gc — ADR-024 L2", () => {
  it("deletes files older than SESSION_FILE_TTL_DAYS", () => {
    // 创建 3 个文件：1 个未过期、1 个刚好过期、1 个远过期
    createSessionFile(tmpHome, "/proj", "recent.jsonl", 1);
    createSessionFile(tmpHome, "/proj", "borderline.jsonl", SESSION_FILE_TTL_DAYS + 1);
    createSessionFile(tmpHome, "/proj", "old.jsonl", SESSION_FILE_TTL_DAYS + 60);

    const deleted = cleanupExpiredSessionFiles(tmpHome, "/proj");
    expect(deleted).toBe(2);

    const dir = getSessionsDir(tmpHome, "/proj");
    const remaining = fs.readdirSync(dir);
    expect(remaining).toContain("recent.jsonl");
    expect(remaining).not.toContain("borderline.jsonl");
    expect(remaining).not.toContain("old.jsonl");
  });

  it("keeps files within TTL", () => {
    createSessionFile(tmpHome, "/proj", "f1.jsonl", 0);
    createSessionFile(tmpHome, "/proj", "f2.jsonl", SESSION_FILE_TTL_DAYS - 1);

    const deleted = cleanupExpiredSessionFiles(tmpHome, "/proj");
    expect(deleted).toBe(0);
    const dir = getSessionsDir(tmpHome, "/proj");
    expect(fs.readdirSync(dir)).toHaveLength(2);
  });

  it("returns 0 when directory does not exist", () => {
    expect(cleanupExpiredSessionFiles(tmpHome, "/nonexistent")).toBe(0);
  });

  it("only processes .jsonl files (ignores others)", () => {
    const dir = getSessionsDir(tmpHome, "/proj");
    fs.mkdirSync(dir, { recursive: true });
    // 创建一个非 jsonl 文件，mtime 很旧
    const oldFile = path.join(dir, "notes.txt");
    fs.writeFileSync(oldFile, "old", "utf-8");
    const targetTime = new Date(Date.now() - (SESSION_FILE_TTL_DAYS + 30) * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, targetTime, targetTime);

    const deleted = cleanupExpiredSessionFiles(tmpHome, "/proj");
    expect(deleted).toBe(0);
    expect(fs.existsSync(oldFile)).toBe(true);
  });

  it("isolates cleanup by cwd", () => {
    createSessionFile(tmpHome, "/proj-a", "old.jsonl", SESSION_FILE_TTL_DAYS + 30);
    createSessionFile(tmpHome, "/proj-b", "old.jsonl", SESSION_FILE_TTL_DAYS + 30);

    const deleted = cleanupExpiredSessionFiles(tmpHome, "/proj-a");
    expect(deleted).toBe(1);
    // proj-b 的文件不受影响
    const dirB = getSessionsDir(tmpHome, "/proj-b");
    expect(fs.readdirSync(dirB)).toHaveLength(1);
  });

  it("maybeCleanup with probability=1 always runs", () => {
    createSessionFile(tmpHome, "/proj", "old.jsonl", SESSION_FILE_TTL_DAYS + 30);
    // probability=1 必触发
    const deleted = maybeCleanupExpiredSessionFiles(tmpHome, "/proj", 1);
    expect(deleted).toBe(1);
  });

  it("maybeCleanup with probability=0 never runs", () => {
    createSessionFile(tmpHome, "/proj", "old.jsonl", SESSION_FILE_TTL_DAYS + 30);
    const deleted = maybeCleanupExpiredSessionFiles(tmpHome, "/proj", 0);
    expect(deleted).toBe(0);
    const dir = getSessionsDir(tmpHome, "/proj");
    expect(fs.readdirSync(dir)).toHaveLength(1);
  });
});
