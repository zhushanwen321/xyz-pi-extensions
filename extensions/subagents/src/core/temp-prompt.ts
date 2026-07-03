// src/core/temp-prompt.ts
//
// 将 agent systemPrompt 写入临时文件，供 pi CLI --append-system-prompt 使用。
// Core 叶子原语（仅依赖 node 内置）。
//
// pi CLI 的 --append-system-prompt 接受文件路径（非内联字符串），故 spawn 前
// 需把 systemPrompt 落盘。每次调用创建唯一临时目录，用完由 runSpawn 清理。
//
// 移植自 nicobailon subagent example，去掉 withFileMutationQueue（目录已唯一，
// 无并发写入风险，queue 冗余）。

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 临时 prompt 文件创建结果。dir 供调用方清理。 */
export interface TempPromptFile {
  /** 临时目录绝对路径（mkdtemp 创建，调用方负责删除）。 */
  dir: string;
  /** prompt 文件绝对路径（dir 下）。 */
  filePath: string;
}

/**
 * 将 systemPrompt 写入临时文件。
 *
 * @param agentName agent 名称（用于文件名，非法字符替换为 _）
 * @param prompt systemPrompt 全文
 * @returns 临时文件信息（dir + filePath）
 *
 * 安全：文件权限 0o600（仅 owner 读写），防止其他用户读取 prompt 内容。
 * 目录用 mkdtemp 保证唯一，无需额外锁。
 */
export async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<TempPromptFile> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safeName}.md`);
  await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

/**
 * 删除临时 prompt 目录（含文件）。best-effort，失败不抛。
 *
 * runSpawn 的 finally 调用，确保临时文件不泄漏。子进程可能仍持有文件句柄
 * （--append-system-prompt 读取后即释放），rm 用 recursive 容错。
 */
export async function cleanupTempPrompt(file: TempPromptFile): Promise<void> {
  try {
    await fs.promises.rm(file.dir, { recursive: true, force: true });
  } catch {
    // best-effort：临时文件泄漏不影响功能，OS tmpdir 清理机制兜底
  }
}
