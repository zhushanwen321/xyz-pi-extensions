// src/__tests__/alive-store.test.ts

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach,describe, expect, it } from "vitest";

import {
  isProcessAlive,
  readAliveMarker,
  removeAliveMarker,
  writeAliveMarker,
} from "../alive-store.ts";
import type { AliveMarker } from "../types.ts";

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "alive-store-test-"));
}

describe("alive-store", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ── writeAliveMarker + readAliveMarker 往返 ──

  it("write → read round-trip", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const marker: AliveMarker = { pid: 12345, id: "bg-1-abc", startedAt: Date.now() };

    writeAliveMarker(sessionFile, marker);
    const result = readAliveMarker(sessionFile);

    expect(result).toEqual(marker);
    // 验证 sidecar 文件是单行 JSON
    const raw = fs.readFileSync(`${sessionFile}.alive`, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw.trim())).toEqual(marker);
  });

  // ── readAliveMarker 损坏文件 ──

  it("readAliveMarker returns undefined for corrupted file", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    fs.writeFileSync(`${sessionFile}.alive`, "not-json", "utf-8");

    expect(readAliveMarker(sessionFile)).toBeUndefined();
  });

  it("readAliveMarker returns undefined for structurally invalid JSON", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    // pid 字段缺失
    fs.writeFileSync(`${sessionFile}.alive`, '{"id":"x","startedAt":1}\n', "utf-8");

    expect(readAliveMarker(sessionFile)).toBeUndefined();
  });

  it("readAliveMarker returns undefined when file does not exist", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");

    expect(readAliveMarker(sessionFile)).toBeUndefined();
  });

  // ── removeAliveMarker ──

  it("removeAliveMarker removes existing sidecar", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");
    const marker: AliveMarker = { pid: 1, id: "x", startedAt: 0 };

    writeAliveMarker(sessionFile, marker);
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(true);

    removeAliveMarker(sessionFile);
    expect(fs.existsSync(`${sessionFile}.alive`)).toBe(false);
  });

  it("removeAliveMarker does not throw when file does not exist", () => {
    tmpDir = makeTmpDir();
    const sessionFile = path.join(tmpDir, "session.jsonl");

    expect(() => removeAliveMarker(sessionFile)).not.toThrow();
  });

  // ── isProcessAlive ──

  it("isProcessAlive returns true for current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive returns false for non-existent pid", () => {
    // pid 0 不存在于用户空间（kill(0,0) 在某些 OS 有特殊语义，用大数更安全）
    expect(isProcessAlive(9999999)).toBe(false);
  });

  it("isProcessAlive returns true for EPERM (process exists but no permission)", () => {
    // 模拟 EPERM：进程存在但无权限发信号
    const err = new Error("EPERM") as NodeJS.ErrnoException;
    err.code = "EPERM";
    const originalKill = process.kill;
    process.kill = (_pid: number, _signal?: string | number) => {
      throw err;
    };
    try {
      expect(isProcessAlive(12345)).toBe(true);
    } finally {
      process.kill = originalKill;
    }
  });

  it("isProcessAlive returns false for ESRCH (no such process)", () => {
    // 模拟 ESRCH：进程不存在
    const err = new Error("ESRCH") as NodeJS.ErrnoException;
    err.code = "ESRCH";
    const originalKill = process.kill;
    process.kill = (_pid: number, _signal?: string | number) => {
      throw err;
    };
    try {
      expect(isProcessAlive(12345)).toBe(false);
    } finally {
      process.kill = originalKill;
    }
  });

  it("isProcessAlive returns false for unknown errors", () => {
    // 模拟未知错误：保守判死
    const originalKill = process.kill;
    process.kill = (_pid: number, _signal?: string | number) => {
      throw new Error("unknown error");
    };
    try {
      expect(isProcessAlive(12345)).toBe(false);
    } finally {
      process.kill = originalKill;
    }
  });
});
