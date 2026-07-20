// src/execution/rpc-channel.ts
//
// RPC 写入通道：封装「往子进程 stdin 写一行 JSON」+ 写入维度的存活判断。
//
// 单一真相源：dead 标志由 child close/error 事件 + stdin stream error + write catch
// 三路同步置位，一旦 true 永不复位。write() 是 total function（永不抛），调用方靠
// 返回值降级。构造时挂 child.stdin 'error' listener，根治 stream error → uncaughtException
//（取代 W1 在 session-runner 加的临时 ad-hoc listener）。
//
// 详见 docs/evolution/006-subagent-rpc-channel-error-boundary.md。

import type { ChildProcess } from "node:child_process";

/**
 * RPC 写入通道：与 child 同生命周期，作为 stdin 写入维度的单一真相源。
 *
 * 关键性质：
 *   - `write()` 是 total function（永不抛），返回 boolean 指示写入是否成功
 *   - `dead` 标志一旦置 true 永不复位（子进程死了不会复活）
 *   - 构造时挂 stdin 'error' listener，保证 stream error 一定被吸收——根治 uncaughtException
 *   - `dead` 由三路同步置位（close/error 事件 + stdin stream error + write catch）
 */
export class ChildRpcChannel {
  private dead = false;
  /** @internal 保留 child 引用供 write 访问 stdin；外部不应直接用 */
  private readonly child: ChildProcess;
  readonly pid?: number;

  constructor(child: ChildProcess) {
    this.child = child;
    this.pid = child.pid;
    child.on("close", () => {
      this.dead = true;
    });
    child.on("error", () => {
      this.dead = true;
    });
    // 关键：吸收 stdin stream 'error' 事件，防止异步 stream error 升级为 uncaughtException
    // 冲垮父进程。write() 的 try/catch 只接同步 throw；子进程退出后 stdin 的 RST 在事件循环
    // 里异步触发 'error'，没有 listener 会直接变成 uncaughtException。
    // EPIPE 是最常见场景（write catch 已 warn 过，这里静默避免重复噪音）；其他 error warn 不抛。
    child.stdin?.on("error", (err: Error) => {
      this.dead = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPIPE") return; // 子进程已退出，预期，静默
      console.warn(`[subagents] stdin stream error on pid ${this.pid ?? "?"}:`, err);
    });
  }

  /** 通道是否已断（子进程 close/error 或 stdin stream error 或 write catch 触发后置 true）。 */
  get isDead(): boolean {
    return this.dead;
  }

  /**
   * 写一行 JSON（自动补换行）。永不抛，成功返回 true，通道断/写失败返回 false。
   *
   * 三层防护：
   *   1. dead 标志前置检查（通道已断直接 return false）
   *   2. stdin null/destroyed 检查（同步置位 dead 后 return false）
   *   3. write 同步抛错 try/catch（置位 dead 后 return false，warn 记录原因）
   *
   * [R1] write 返回 false（背压）时记 warn（不阻塞，内核缓冲会随后排空）。
   */
  write(line: string): boolean {
    if (this.dead) return false;
    if (!this.child.stdin || this.child.stdin.destroyed) {
      this.dead = true;
      return false;
    }
    try {
      const ok = this.child.stdin.write(line + "\n");
      if (!ok) console.warn(`[subagents] stdin backpressure on pid ${this.pid ?? "?"}`);
      return true;
    } catch (err) {
      this.dead = true;
      const code = (err as NodeJS.ErrnoException).code;
      console.warn(
        `[subagents] stdin write failed on pid ${this.pid ?? "?"} (${code ?? "unknown"})`,
      );
      return false;
    }
  }
}
