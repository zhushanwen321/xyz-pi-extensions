// src/__tests__/run-spawn-edges.test.ts
//
// runSpawn 的 stdout 边界与 orphan 进程兜底集成测试（从 run-spawn-integration.test.ts 拆出）。
//
// 本文件覆盖：
//   - [C1] orphan 进程兜底：killAllSpawnedChildren 对未退出 child 发 SIGTERM。
//   - [M8] stdout 边界：损坏行（非法 JSON / 缺 type）静默忽略 + 残留尾行（close 前无 \n）
//     由 close handler 再 parse。
//   - [agent_end] rpc 长驻进程自然完成：agent_end（willRetry=false）→ kill SIGTERM 触发 close。
//
// mock 工厂 + FakeChild + 工具函数共享自 helpers/spawn-mock.ts（详见该文件头注释）。
// vi.mock 必须各文件独立声明（文件作用域），工厂内用 `await import` 取回 FakeChild。

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const { FakeChild } = await import("./helpers/spawn-mock.ts");
  return {
    spawn: vi.fn(() => new FakeChild()),
    execFileSync: vi.fn(() => ""),
  };
});

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return {
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      existsSync: vi.fn(() => false),
      appendFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => false),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    promises: actual.promises,
  };
});

vi.mock("../alive-store.ts", () => ({
  writeAliveMarker: vi.fn(),
}));

vi.mock("../temp-prompt.ts", () => ({
  writePromptToTempFile: vi.fn(async (agent: string) => {
    const safeName = agent.replace(/[^\w.-]+/g, "_");
    return { dir: `/tmp/fake-${safeName}`, filePath: `/tmp/fake-${safeName}/prompt-${safeName}.md` };
  }),
  cleanupTempPrompt: vi.fn(async () => {}),
}));

import { killAllSpawnedChildren, runSpawn, spawnedChildren } from "../session-runner.ts";
import {
  emitStdoutLine,
  type FakeChild,
  lastSpawnedChild as lastSpawnedChildOf,
  makeCtx,
  makeOpts,
  makeRecord,
  sessionHeader,
  waitForSpawn as waitForSpawnOf,
} from "./helpers/spawn-mock.ts";

const mockSpawn = vi.mocked(spawn);
const mockExec = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(fs.existsSync);

// 绑定到本文件 mockSpawn 的 lastSpawnedChild/waitForSpawn（需读 mockSpawn.mock.results）
const lastSpawnedChild = (): FakeChild => lastSpawnedChildOf(mockSpawn);
const waitForSpawn = (timeoutMs = 1000): Promise<void> => waitForSpawnOf(mockSpawn, timeoutMs);

// ============================================================
// 测试
// ============================================================

describe("runSpawn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // execFileSync 默认返回空串（git branch 兜底）
    mockExec.mockReturnValue("");
    // existsSync 默认 false（sessionFile 不存在兜底路径）
    mockExistsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. orphan 进程兜底（C1）──
  //
  // [C1] runSpawn 把每个 spawned child（sync + background）注册到模块级 spawnedChildren Set。
  // SubagentService.dispose 调 killAllSpawnedChildren 遍历该 Set 对仍存活的子进程发 SIGTERM，
  // 覆盖 sync 子进程（controller=undefined，abortRunningControllers 跳过它）。
  //
  // 关键验证：
  //   1. child 退出（close/error）后从 Set 移除 → killAllSpawnedChildren 不重复 kill。
  //   2. child 未退出时 killAllSpawnedChildren → child.kill("SIGTERM") 被调。
  //   3. 已 kill 的 child 二次调用无害（killAllSpawnedChildren 跳过 killed=true 的）。
  describe("orphan 进程兜底 (C1)", () => {
    it("未退出的 child → killAllSpawnedChildren 对它发 SIGTERM", async () => {
      const record = makeRecord();
      // 不 await——runSpawn 内部 await 子进程 close，killAllSpawnedChildren 测试在 close 前
      const promise = runSpawn(record, "Task: orphan", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // spawn 后 child.killed 应为 false（尚未被 kill）
      expect(child.killed).toBe(false);

      // dispose 兜底：killAllSpawnedChildren 应 kill 未退出的 child
      const n = killAllSpawnedChildren();
      expect(n).toBeGreaterThanOrEqual(1);
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");

      // 收尾：emit close 让 runSpawn resolve（避免悬挂）
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 143);

      const result = await promise;
      expect(result.success).toBe(true); // 信号终止视为正常完成
    });

    it("已 close 的 child → 从 Set 移除，killAllSpawnedChildren 不重复 kill", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: closed", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      // 子进程正常退出
      emitStdoutLine(child, sessionHeader());
      child.stdout.end();
      child.emit("close", 0);

      await promise;
      expect(child.killed).toBe(false); // 正常退出未触发 kill

      // close 后 child 已从 Set 移除；再调 killAllSpawnedChildren 不会 kill 它
      const n = killAllSpawnedChildren();
      expect(n).toBe(0);
      expect(child.killed).toBe(false);
    });

    it("多个未退出 child（sync + bg）→ killAllSpawnedChildren 全部 kill", async () => {
      // spawn 两个 child（模拟 sync + background 并发），都未退出。
      // 注意：waitForSpawn 等待 results.length===0→非0 转换，只适用于首次 spawn。
      // 第二次 spawn 需等待 results.length 递增到 2，否则 lastSpawnedChild 取回的是 c1。
      const beforeCount = mockSpawn.mock.results.length;

      const rec1 = makeRecord();
      const p1 = runSpawn(rec1, "Task: c1", makeOpts(), makeCtx());
      await waitForSpawn();
      const c1 = lastSpawnedChild();

      const rec2 = makeRecord();
      const p2 = runSpawn(rec2, "Task: c2", makeOpts(), makeCtx());
      // 等待第二次 spawn：results.length 从 beforeCount+1 涨到 beforeCount+2
      const start = Date.now();
      while (mockSpawn.mock.results.length < beforeCount + 2) {
        if (Date.now() - start > 1000) throw new Error("second spawn not called");
        await new Promise((r) => setTimeout(r, 5));
      }
      const c2 = lastSpawnedChild();

      // c1 和 c2 是不同实例
      expect(c1).not.toBe(c2);
      expect(c1.killed).toBe(false);
      expect(c2.killed).toBe(false);

      // dispose 兜底 kill 两个
      const n = killAllSpawnedChildren();
      expect(n).toBeGreaterThanOrEqual(2);
      expect(c1.killed).toBe(true);
      expect(c2.killed).toBe(true);

      // 收尾
      for (const { child, promise } of [
        { child: c1, promise: p1 },
        { child: c2, promise: p2 },
      ]) {
        emitStdoutLine(child, sessionHeader());
        child.stdout.end();
        child.emit("close", 143);
        const r = await promise;
        expect(r.success).toBe(true);
      }
    });

    // [dispose-cleanup Minor 优化2] killAllSpawnedChildren 末尾 clear spawnedChildren Set。
    // 防主进程崩溃/close 事件漏触发时 Set 无限增长。正常路径 close 事件会 delete（保留 per-child
    // 精细清理语义）；killAllSpawnedChildren 是 dispose 全量兼底。
    it("killAllSpawnedChildren 后 spawnedChildren Set 被 clear（size===0）", async () => {
      // 前置清理：即他测试可能残留的 child（close 未触发场景）
      killAllSpawnedChildren();
      expect(spawnedChildren.size).toBe(0);

      // spawn 两个未 close 的 child（模拟 close 事件漏触发的极端累积场景）
      const rec1 = makeRecord();
      const p1 = runSpawn(rec1, "Task: clear-1", makeOpts(), makeCtx());
      await waitForSpawn();
      const c1 = lastSpawnedChild();

      const beforeCount = mockSpawn.mock.results.length;
      const rec2 = makeRecord();
      const p2 = runSpawn(rec2, "Task: clear-2", makeOpts(), makeCtx());
      const start = Date.now();
      while (mockSpawn.mock.results.length < beforeCount + 1) {
        if (Date.now() - start > 1000) throw new Error("second spawn not called");
        await new Promise((r) => setTimeout(r, 5));
      }
      const c2 = lastSpawnedChild();

      // 两个 child 都在 Set 中
      expect(spawnedChildren.size).toBe(2);

      // dispose 兼底：kill + clear
      const n = killAllSpawnedChildren();
      expect(n).toBe(2);
      expect(c1.killed).toBe(true);
      expect(c2.killed).toBe(true);
      // Set 被 clear（兑底防泄漏）
      expect(spawnedChildren.size).toBe(0);

      // 再次调用：Set 已空，返回 0（不会重复 kill 已 kill 的 child）
      const n2 = killAllSpawnedChildren();
      expect(n2).toBe(0);

      // 收尾
      for (const { child, promise } of [
        { child: c1, promise: p1 },
        { child: c2, promise: p2 },
      ]) {
        emitStdoutLine(child, sessionHeader());
        child.stdout.end();
        child.emit("close", 143);
        const r = await promise;
        expect(r.success).toBe(true);
      }
    });
  });

  // ── 2. stdout 边界：损坏行 + 残留尾行 (M8) ──
  //
  // [M8] runSpawn 的 stdout 解析容错：
  //   - parseSpawnLine 对「非法 JSON」「合法 JSON 但缺 type 字段」归为 kind:"invalid"。
  //   - runSpawn 的 data 处理器只认 header/event 两类，invalid 行静默忽略（L559 注释
  //     "invalid 行忽略"）——单行损坏不应中断整个事件流。
  //   - close 前 stdoutBuffer 若残留未以 \n 结尾的合法 event 行，close handler 会再 parse
  //     一次（L574-579）——覆盖子进程末行漏 \n 的场景。
  describe("stdout 边界：损坏行 + 残留尾行 (M8)", () => {
    it("stdout 夹杂非法 JSON 行 → 该行被忽略，合法 turn_end 正常计数（不抛错）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: garbage", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 非法 JSON 行（如 pi 的调试输出 / 进度条残片）—— parseSpawnLine 归为 invalid
      child.stdout.write("this is not json\n");
      // 合法 turn_end 事件
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 非法行被忽略，仅 turn_end 计数
    });

    it("stdout 夹杂合法 JSON 但缺 type 字段 → 该行被忽略，不抛错", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: notype", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 合法 JSON 但无 type 字段 —— parseSpawnLine 归为 invalid（"missing string 'type'"）
      child.stdout.write('{"foo":"bar"}\n');
      emitStdoutLine(child, { type: "turn_end" });
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 无 type 行被忽略
    });

    it("残留尾行（close 前未以 \\n 结尾的合法 event）→ close handler 再 parse 处理", async () => {
      // 覆盖 session-runner.ts L574-579：close 前 stdoutBuffer 残留的合法 event 行。
      //
      // 关键：不能用 emitStdoutLine（它会补 \n，残留行在 data 处理器就被 split 消费了，
      // 走不到 close handler 的残留 parse 分支）。需同步 emit data（无 \n）确保该行
      // 残留在 stdoutBuffer 直到 close handler 处理。
      //
      // 同步 emit 的必要性：PassThrough 的 .write() 会把 data flush 排到后续微任务，
      // 若先 .write() 再 emit("close")，close listener 同步执行时 stdoutBuffer 仍为空
      // → 残留逻辑被跳过 → turnCount=0（测出真实 bug 风险）。直接 emit("data", ...) 同步
      // 触发 data 处理器，使行残留在 buffer（split("\n") 无换行 → pop 回 buffer），close
      // handler 才能捕到它。
      const record = makeRecord();
      const promise = runSpawn(record, "Task: tail", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // 合法 turn_end 但不带末尾 \n：同步 emit（绕过 write 的异步 flush）。
      // data 处理器把它整体留在 stdoutBuffer（无 \n → split 后 pop 回 buffer），
      // 由 close handler 的残留 parse 逻辑（L574-579）处理。
      child.stdout.emit("data", JSON.stringify({ type: "turn_end" }));
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 残留尾行被 close handler 正确解析
    });

    it("同一 JSON 行跨 3 次 data 事件分片 → stdoutBuffer 字符串拼接后正确解析", async () => {
      // 覆盖 stdoutBuffer += data 的字符串拼接（setEncoding("utf8") 后 data 收到 string，
      // 非 Buffer）。拆成 3 片写入（跨 type 字段名边界 + 跨 turn_end 值边界），验证拼接无误。
      // .write() 的异步 flush 在 await promise（resolve 排在 data 微任务之后）前完成。
      const record = makeRecord();
      const promise = runSpawn(record, "Task: split3", makeOpts(), makeCtx());

      // 等待 spawn 被调用拿到 child
      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      child.stdout.write('{"typ');
      child.stdout.write('e":"turn_en');
      child.stdout.write('d"}\n');
      child.stdout.end();
      child.emit("close", 0);

      const result = await promise;

      expect(result.success).toBe(true);
      expect(record.turnCount).toBe(1); // 3 片拼接后解析为 1 次 turn_end
    });
  });

  // ── 3. agent_end 自然完成（rpc 长驻进程不自动退出，需主动 kill）──
  //
  // [rpc agent_end] pi --mode rpc 是长驻进程（runRpcMode 末尾 return new Promise(() => {})），
  // 处理完 prompt 后不退出。runSpawn 只靠 child.on("close") 判完成——如果不处理 agent_end，
  // 子进程会卡到 watchdog 30 分钟兜底 kill。修复：收到 agent_end（willRetry=false）后
  // 主动 child.kill("SIGTERM") 让子进程退出，触发 close → runSpawn resolve。
  // willRetry=true 时 agent 会重试，不能 kill。
  describe("agent_end 自然完成", () => {
    it("agent_end（willRetry=false）→ child.kill(SIGTERM) 被调用，close 后 success=true", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: done", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // agent 自然完成（willRetry=false）
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      child.stdout.end();
      child.stderr.end();
      // agent_end 触发 kill(SIGTERM) → 子进程退出（exitCode 143 = 128+15）
      child.emit("close", 143);

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      // 信号终止（>=128）视为正常完成
      expect(result.success).toBe(true);
    });

    it("agent_end（willRetry=true）→ child.kill 不被调用（agent 会重试，等下一个 agent_end）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: retry", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // willRetry=true：agent 会重试，不应 kill
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: true });
      // 此时 child.killed 应仍为 false。给一点时间让 event pump 处理完。
      await new Promise((r) => setTimeout(r, 10));
      expect(child.killed).toBe(false);

      // 收尾：模拟重试后的最终完成（willRetry=false）
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);

      const result = await promise;

      // 最终的 agent_end（willRetry=false）触发 kill
      expect(child.killed).toBe(true);
      expect(child.killSignal).toBe("SIGTERM");
      expect(result.success).toBe(true);
    });

    it("agent_end 后的后续 event 仍被 handleSdkEvent 处理（kill 不阻塞 event pump）", async () => {
      const record = makeRecord();
      const promise = runSpawn(record, "Task: flush", makeOpts(), makeCtx());

      await waitForSpawn();
      const child = lastSpawnedChild();

      emitStdoutLine(child, sessionHeader());
      // agent_end kill 是 fire-and-forget（SIGTERM 异步），后续 stdout 行仍被 event pump 处理
      emitStdoutLine(child, { type: "agent_end", messages: [], willRetry: false });
      emitStdoutLine(child, { type: "turn_end" }); // kill 后的 turn_end 仍应被处理
      child.stdout.end();
      child.stderr.end();
      child.emit("close", 143);

      const result = await promise;

      expect(child.killed).toBe(true);
      expect(result.success).toBe(true);
      // turn_end 被处理 → turnCount=1
      expect(record.turnCount).toBe(1);
    });
  });
});
