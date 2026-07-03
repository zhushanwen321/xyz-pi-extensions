// src/core/pi-invocation.ts
//
// 定位 pi 二进制并组装 spawn 调用。Core 叶子原语（仅依赖 node 内置）。
//
// spawn 改造（in-process → spawn pi --mode json）的基座模块。
// 被 runSpawn（session-runner）调用，决定子进程用哪个命令启动。
//
// 移植自 nicobailon subagent example 的 getPiInvocation，处理三种运行时：
//   1. bun bundle（/$bunfs/root/ 虚拟脚本）→ 退化到 pi-in-PATH
//   2. 有真实脚本路径（node + script）→ node <script> <args>
//   3. node/bun generic runtime（无脚本）→ pi <args>（依赖 PATH）
//
// 注意：pi 在扩展进程内运行时 process.execPath 是 node/bun，process.argv[1]
// 是 pi 的入口脚本。子进程需要复现同样的启动方式才能保证扩展/配置一致加载。

import * as fs from "node:fs";
import * as path from "node:path";

/** spawn 调用描述符：command + args（透传给 child_process.spawn）。 */
export interface PiInvocation {
  /** 可执行文件路径（node/bun/pi 二进制）。 */
  command: string;
  /** 命令行参数（可能含 [scriptPath, ...userArgs] 或直接 [...userArgs]）。 */
  args: string[];
}

/**
 * bun 虚拟文件系统前缀。bun bundle 模式下 process.argv[1] 形如
 * /$bunfs/root/pi——这不是磁盘上的真实文件，不能直接 spawn。
 */
const BUN_VIRTUAL_PREFIX = "/$bunfs/root/";

/**
 * 判断 execPath 的 basename 是否为通用运行时（node/bun）。
 * 通用运行时需要脚本路径才能启动 pi；非通用（如 pi 的 standalone binary）可直接执行。
 */
function isGenericRuntime(execPath: string): boolean {
  const execName = path.basename(execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(execName);
}

/**
 * 组装 pi 子进程的 spawn 调用。
 *
 * @param userArgs pi CLI 参数（如 ["--mode", "json", "-p", "Task: ..."]）
 * @returns spawn 描述符（command + 完整 args）
 *
 * 决策链（按优先级）：
 *   1. process.argv[1] 是真实磁盘文件且非 bun 虚拟路径 → <execPath> <argv[1]> <userArgs>
 *      （复现当前 pi 进程的启动方式，确保扩展/配置/版本一致）
 *   2. execPath 非通用运行时（pi standalone binary）→ <execPath> <userArgs>
 *   3. 通用运行时但无可用脚本路径 → "pi" <userArgs>（依赖 PATH 中可找到 pi）
 */
export function getPiInvocation(userArgs: string[]): PiInvocation {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith(BUN_VIRTUAL_PREFIX);

  // 分支 1：有真实脚本路径 → 复现启动方式（node <pi-script> <args>）
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...userArgs] };
  }

  // 分支 2：非通用运行时（pi 自带 binary）→ 直接执行
  if (!isGenericRuntime(process.execPath)) {
    return { command: process.execPath, args: userArgs };
  }

  // 分支 3：通用运行时但脚本不可用 → 依赖 PATH
  return { command: "pi", args: userArgs };
}
