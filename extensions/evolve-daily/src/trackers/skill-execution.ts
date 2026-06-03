/**
 * skill-execution Tracker 配置
 *
 * 从 skill-state 扩展迁移的第一个 Tracker 实例。
 * 追踪 skill 的加载、执行、异常、记录全生命周期。
 */

import type { TrackedItem } from "./types";
import type { TrackerConfig } from "./core";

// ── Metadata 类型 ───────────────────────────────────

export interface SkillMeta {
  skillMdPath: string;
}

// ── 工具函数（从 skill-state/state.ts 迁移）────────

/**
 * 从路径中提取 skill 名称。
 * 路径必须以 SKILL.md 结尾，名称取倒数第二级目录。
 */
export function extractSkillName(path: string): string | null {
  if (!path.endsWith("SKILL.md")) return null;
  const MIN_PATH_SEGMENTS = 2;
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.length < MIN_PATH_SEGMENTS) return null;
  return segments[segments.length - MIN_PATH_SEGMENTS] ?? null;
}

// ── Steering 模板（从 skill-state/templates.ts 迁移）──

function loadedSteeringPrompt(name: string, id: number): string {
  return (
    `[SKILL-STATE] skill "${name}" 已加载并开始追踪（id=${id}）。\n` +
    `执行完成后调用 skill_state(action=update, id=${id}, status=completed)。\n` +
    `遇到困难时调用 skill_state(action=update, id=${id}, status=error, detail="原因")。`
  );
}

function remindSteeringPrompt(
  name: string,
  turnsSinceLoad: number,
): string {
  return `[SKILL-STATE] skill "${name}" 已加载 ${turnsSinceLoad} turn 未终态，请调用 skill_state 工具流转状态。`;
}

function errorForceRecordPrompt(item: TrackedItem<SkillMeta>): string {
  return (
    `[SKILL-STATE] skill "${item.name}" 异常次数已达 ${item.errorCount} 次，需要记录问题。\n` +
    `请立即调用 subagent 工具（background 模式），任务如下：\n` +
    `1. 读取 ${item.metadata.skillMdPath}\n` +
    `2. 根据当前 session 上下文分析 skill "${item.name}" 执行中遇到的问题\n` +
    `3. 生成结构化问题记录（skill 名称、异常次数、问题描述、改进建议）\n` +
    `完成后调用 skill_state(action=update, id=${item.id}, status=recorded) 标记记录完成。`
  );
}

function agentStartContextPrompt(items: TrackedItem<SkillMeta>[]): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (item) => `  - "${item.name}" (id=${item.id}, status=${item.status})`,
  );
  return (
    `[SKILL-STATE] 以下 skill 正在追踪中，请适时调用 skill_state 工具流转状态：\n` +
    lines.join("\n")
  );
}

// ── Tracker 配置对象 ────────────────────────────────

export const skillExecutionConfig: TrackerConfig<SkillMeta> = {
  name: "skill-execution",
  toolName: "skill_state",
  label: "Skill State",
  description:
    "管理 skill 执行追踪状态。" +
    "\n\n可用 action：" +
    "\n- list：查看所有 TrackedItem" +
    "\n- update：更新 TrackedItem 状态（需要 id 和 status）",
  promptSnippet: "追踪 skill 执行状态，自动检测 skill 加载",
  promptGuidelines: [
    "[触发] skill 加载时自动创建追踪，无需手动创建",
    "[流转] 执行完成后用 update status=completed 标记成功",
    "[异常] 遇到困难时用 update status=error 标记异常",
    "[记录] 异常累积 2 次后系统会要求记录问题，完成后 update status=recorded",
    "[查询] 随时用 list 查看所有追踪状态",
  ],

  triggerEvent: "tool_call",
  triggerMatch: (event: unknown) => {
    const evt = event as Record<string, unknown>;
    if (evt.toolName !== "read") return null;
    const path = evt.input &&
      typeof evt.input === "object" &&
      (evt.input as Record<string, unknown>).path;
    if (typeof path !== "string") return null;

    const name = extractSkillName(path);
    if (!name) return null;

    return {
      name,
      metadata: { skillMdPath: path } satisfies SkillMeta,
      summary: `read ${path}`,
    };
  },

  steering: {
    onCreate: (item) => loadedSteeringPrompt(item.name, item.id),
    onRemind: (item, turns) =>
      remindSteeringPrompt(item.name, turns),
    onError: (item) => errorForceRecordPrompt(item),
    onContextRestore: (items) => agentStartContextPrompt(items),
  },

  entryType: "evolve-tracker-skill",
  legacyEntryTypes: ["skill-state-tracker"],
  messageTypes: [
    "evolve-tracker-skill-context",
    "evolve-tracker-skill-remind",
    "evolve-tracker-skill-force-record",
  ],
  remindInterval: 10,
  errorThreshold: 2,
};
