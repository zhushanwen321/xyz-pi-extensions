/**
 * Workflow 文件持久化操作（save / delete）。
 *
 * 历史：saveWorkflow 曾有两套实现——commands.ts 用 renameSync 仅 project scope，
 * WorkflowsView.ts 用 copyFileSync 支持 user scope。本次统一为 rename + 仅 project
 * scope（决策 2）：tmp 文件保存后自动消失，保存位置固定 .pi/workflows/。
 *
 * 代价：TUI 失去 user scope Tab 切换（功能倒退，已接受）；
 * Windows/跨设备 rename 可能失败（已知风险，接受）。
 */

import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";

import { loadWorkflows } from "./config-loader.js";

// ── Path helpers (computed at call time to respect cwd changes in tests) ──

function getTmpDir(): string {
  return resolve(".pi/workflows/.tmp");
}

function getSavedDir(): string {
  return resolve(".pi/workflows");
}

// ── Save ──────────────────────────────────────────────────────

/**
 * 保存临时 workflow：.pi/workflows/.tmp/{name}.js → .pi/workflows/{newName||name}.js
 * 用 rename（tmp 文件保存后消失）。仅 project scope。
 * @throws 若 tmp workflow 不存在、目标已存在、或 rename 失败
 */
export async function saveWorkflow(tmpName: string, newName?: string): Promise<string> {
  const workflows = await loadWorkflows();
  const target = workflows.find(
    (wf) => wf.source === "tmp" && wf.name === tmpName,
  );
  if (!target) {
    throw new Error(`Temporary workflow '${tmpName}' not found`);
  }

  const destName = newName ?? tmpName;
  const savedDir = getSavedDir();
  const destPath = resolve(savedDir, `${destName}.js`);

  if (existsSync(destPath)) {
    throw new Error(`'${destName}' already exists in saved workflows. Use a different name.`);
  }

  mkdirSync(savedDir, { recursive: true });
  renameSync(target.path, destPath);
  return `Saved '${tmpName}' → '${destName}' (${destPath})`;
}

// ── Delete ────────────────────────────────────────────────────

/**
 * 删除 workflow 脚本文件（tmp 或 saved）。
 * @param isRunning 回调，判断某 name 是否正在运行（运行中拒绝删除）
 * @throws 若正在运行、或文件不存在
 */
export function deleteWorkflow(
  name: string,
  isRunning: (name: string) => boolean,
): string {
  if (isRunning(name)) {
    throw new Error(`Cannot delete '${name}': workflow is currently running. Abort it first.`);
  }

  const tmpDir = getTmpDir();
  const savedDir = getSavedDir();
  const candidates = [
    resolve(tmpDir, `${name}.js`),
    resolve(savedDir, `${name}.js`),
  ];

  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return `Deleted workflow '${name}' (${filePath})`;
    }
  }

  throw new Error(`Workflow file '${name}' not found`);
}
