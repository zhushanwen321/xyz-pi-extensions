/**
 * skill-execution Tracker 配置
 *
 * 从 skill-state 扩展迁移的第一个 Tracker 实例。
 * 追踪 skill 的加载、执行、异常、记录全生命周期。
 */

import type { TrackerConfig } from "./core";
import type { TrackedItem } from "./types";

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
    `[SKILL-STATE] skill "${name}" loaded and tracking started (id=${id}).\n` +
    `When done, call skill_state(action=update, id=${id}, status=completed).\n` +
    `If blocked, call skill_state(action=update, id=${id}, status=error, detail="reason").`
  );
}

function remindSteeringPrompt(
  name: string,
  turnsSinceLoad: number,
): string {
  return `[SKILL-STATE] skill "${name}" loaded ${turnsSinceLoad} turns ago without reaching terminal state. Please call skill_state to update its status.`;
}

function errorForceRecordPrompt(item: TrackedItem<SkillMeta>): string {
  return (
    `[SKILL-STATE] skill "${item.name}" has reached ${item.errorCount} errors — issue recording required.\n` +
    `Immediately call the subagent tool (background mode) with this task:\n` +
    `1. Read ${item.metadata.skillMdPath}\n` +
    `2. Analyze issues encountered during skill "${item.name}" execution based on current session context\n` +
    `3. Generate a structured issue record (skill name, error count, issue description, improvement suggestions)\n` +
    `After completion, call skill_state(action=update, id=${item.id}, status=recorded).`
  );
}

function agentStartContextPrompt(items: TrackedItem<SkillMeta>[]): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (item) => `  - "${item.name}" (id=${item.id}, status=${item.status})`,
  );
  return (
    `[SKILL-STATE] The following skills are being tracked — call skill_state to update their status when appropriate:\n` +
    lines.join("\n")
  );
}

// ── Tracker 配置对象 ────────────────────────────────

export const skillExecutionConfig: TrackerConfig<SkillMeta> = {
  name: "skill-execution",
  toolName: "skill_state",
  label: "Skill State",
  description:
    "Manage skill execution tracking state." +
    "\n\nAvailable actions:" +
    "\n- list: View all TrackedItems" +
    "\n- update: Update TrackedItem status (requires id and status)",
  promptSnippet: "Track skill execution status with automatic skill load detection",
  promptGuidelines: [
    "[Trigger] Tracking is auto-created when a skill loads — no manual creation needed",
    "[Transition] After execution, use update status=completed to mark success",
    "[Error] When blocked, use update status=error to mark the exception",
    "[Record] After 2 accumulated errors, the system requests issue recording — when done, update status=recorded",
    "[Query] Use list anytime to view all tracking states",
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
