// src/runtime/worktree-registry.ts
//
// 全局 worktree 注册表：跨 repo 记录所有活 pi-sub-* worktree。
//
// 取代旧的 per-cwd 扫描 + .session mapping sidecar 链。
// 旧 reaper 的两个根本缺陷由此消除：
//   1. 触发覆盖：旧 scan 扫「当前 cwd 对应的 repo」，workspace 根 / 非 git 目录启动时
//      rev-parse 报错整个挂掉；且 tmpdir 下的 checkout 永远不会被 pi cwd "看到"。
//      → 新 scan 遍历全局注册表，不依赖 cwd 是否 git repo。
//   2. 判据脆弱：旧 scan 用 .finalized/.cancelled 终态 marker 作主判据，进程崩溃时
//      无人写终态 → 孤儿永久泄漏。→ 新判据：pid 死活一条判到底。
//
// 并发模型：
//   - 同步 IO（readFileSync/writeFileSync）。Node 单线程保证 sync read-modify-write
//     在一个 event loop turn 内原子完成，进程内无需 mutex。
//   - 多 WorktreeManager 实例（reaper + service）共享同一文件，sync 操作天然串行。
//   - 跨进程（用户开两个 pi）：last-write-wins，丢失条目靠 OS tmpdir + 分支对账兜底。
//   - 原子写：写 .tmp → rename，防写一半崩溃产生损坏 JSON。

import * as fs from "node:fs";
import * as path from "node:path";

import { bestEffort } from "./best-effort.ts";

/** create→spawn 宽限期（ms）：pid=0 条目超过此阈值判 create 后崩溃。 */
export const SPAWN_GRACE_MS = 60_000;

/** JSON 缩进空格数（可读性 + diff 友好）。 */
const JSON_INDENT = 2;

/** 注册表 JSON 顶层结构的运行时类型守卫。 */
function isRegistryData(value: unknown): value is { entries: WorktreeEntry[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    "entries" in value &&
    Array.isArray(value.entries)
  );
}

/**
 * 注册表条目：一条 = 一个活 worktree。
 * 字段全部来自 WorktreeHandle + session-runner 已捕获的 child.pid，零新数据源。
 */
export interface WorktreeEntry {
  /** 主仓库根目录（git -C <repo> 操作目标）。 */
  readonly repo: string;
  /** 分支名（"pi-sub-<recordId>"）。 */
  readonly branch: string;
  /** checkout 目录（tmpdir 下，= WorktreeHandle.path）。 */
  readonly checkout: string;
  /** 子进程 pid（0 = create-spawn 窗口，尚未拿到 pid）。 */
  readonly pid: number;
  /** 创建时间戳（ms，SPAWN_GRACE 判据 + 调试用）。 */
  readonly createdAt: number;
}

/**
 * 全局 worktree 注册表。
 *
 * 文件位置：<agentDir>/subagents/worktrees.json（repo 无关层级，跨 repo 共享）
 * 格式：{ "entries": WorktreeEntry[] }
 */
export class WorktreeRegistry {
  private readonly filePath: string;

  constructor(agentDir: string) {
    this.filePath = path.join(agentDir, "subagents", "worktrees.json");
  }

  /**
   * 新增条目（create 成功后调，pid=0 占位）。
   * 同 branch 已存在则覆盖（防残留覆盖）。
   */
  add(entry: WorktreeEntry): void {
    const entries = this.load();
    const idx = entries.findIndex((e) => e.branch === entry.branch);
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    this.save(entries);
  }

  /**
   * 更新 pid（session-runner first header 时调）。
   * branch 不存在则忽略（create 后崩溃 + reaper 已清的竞态）。
   */
  updatePid(branch: string, pid: number): void {
    const entries = this.load();
    const idx = entries.findIndex((e) => e.branch === branch);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], pid };
      this.save(entries);
    }
  }

  /**
   * 移除条目（cleanup/reaper 清理后调）。
   * branch 不存在则忽略（幂等）。
   */
  remove(branch: string): void {
    const entries = this.load();
    const filtered = entries.filter((e) => e.branch !== branch);
    if (filtered.length !== entries.length) {
      this.save(filtered);
    }
  }

  /**
   * 加载全部条目（reaper 遍历用）。
   * 文件不存在 / 解析失败 / IO 错误 → 返回空数组（视为无活 worktree）。
   */
  load(): WorktreeEntry[] {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (isRegistryData(parsed)) {
        return parsed.entries;
      }
      return [];
    } catch {
      // 文件不存在（首次运行）/ 解析失败（损坏）/ IO 错误 → 空注册表
      return [];
    }
  }

  /**
   * 原子写入全部条目。
   * best-effort：写入失败不阻断主流程（create/cleanup 的 git 操作已执行，
   * 注册表与 git 状态的短暂不一致靠下次 reaper 对账收敛）。
   */
  private save(entries: WorktreeEntry[]): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ entries }, null, JSON_INDENT), "utf-8");
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      bestEffort(err, "worktree registry save");
    }
  }
}
