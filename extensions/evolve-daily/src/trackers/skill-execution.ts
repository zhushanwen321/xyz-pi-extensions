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

// ── Steering 模板（从 skill-state/templates.ts 迁移）──

function loadedSteeringPrompt(name: string, id: number): string {
  return (
    `[SKILL-STATE] skill "${name}" tracking started (id=${id}).\n` +
    `When done, call use_skill(action=update, id=${id}, status=completed).\n` +
    `If blocked, call use_skill(action=update, id=${id}, status=error, detail="reason").\n` +
    `If not applicable (you decided not to execute this skill after all), call use_skill(action=update, id=${id}, status=cancelled, detail="reason").`
  );
}

function remindSteeringPrompt(
  name: string,
  turnsSinceLoad: number,
): string {
  return `[SKILL-STATE][INFO] skill "${name}" started ${turnsSinceLoad} turns ago without reaching terminal state. Call use_skill(action=update) to set completed/error/cancelled.`;
}

function errorForceRecordPrompt(item: TrackedItem<SkillMeta>): string {
  const skillPath = item.metadata.skillMdPath;
  const readStep = skillPath
    ? `1. Read ${skillPath}\n`
    : `1. Read the SKILL.md for skill "${item.name}"\n`;
  return (
    `[SKILL-STATE][INFO] skill "${item.name}" reached ${item.errorCount} errors.\n` +
    `Dispatch a subagent (background mode) to:\n` +
    readStep +
    `2. Analyze issues encountered during skill "${item.name}" execution based on current session context\n` +
    `3. Generate a structured issue record (skill name, error count, issue description, improvement suggestions)\n` +
    `Then call use_skill(action=update, id=${item.id}, status=recorded).`
  );
}

function agentStartContextPrompt(items: TrackedItem<SkillMeta>[]): string {
  if (items.length === 0) return "";
  const lines = items.map(
    (item) => `  - "${item.name}" (id=${item.id}, status=${item.status})`,
  );
  return (
    `[SKILL-STATE] The following skills are being tracked — call use_skill(action=update) to update their status when appropriate:\n` +
    lines.join("\n")
  );
}

// ── Tracker 配置对象 ────────────────────────────────

export const skillExecutionConfig: TrackerConfig<SkillMeta> = {
  name: "skill-execution",
  toolName: "use_skill",
  label: "Use Skill",
  description:
    "Declare and track skill execution. Zero false-positive tracking: " +
    "only call start when you DECIDE to act on a skill's instructions.\n\n" +
    "Available actions:\n" +
    "- start: Declare you are about to execute a skill. Call ONCE when you decide " +
    "to follow a skill's guidance. Do NOT call if you only read SKILL.md to " +
    "understand/evaluate/analyze it — that is research, not usage.\n" +
    "- update: Update a tracked item's status (completed/error/cancelled/recorded)\n" +
    "- list: View all tracked items\n\n" +
    "Call criteria: Are you about to ACT according to this skill's instructions? " +
    "Yes -> call start. No (just reading/evaluating) -> do not call.",
  promptSnippet: "Declare skill usage with use_skill tool for accurate tracking",
  promptGuidelines: [
    "[Trigger] Call use_skill(action=start, name=X) when you decide to execute skill X — not when you merely read its SKILL.md",
    "[Transition] After execution, call use_skill(action=update, id=X, status=completed)",
    "[Abandon] If the skill turns out not applicable, call use_skill(action=update, id=X, status=cancelled, detail=\"reason\")",
    "[Error] When blocked, call use_skill(action=update, id=X, status=error)",
    "[Record] After 2 accumulated errors, issue recording required — when done, use_skill(action=update, id=X, status=recorded)",
    "[Query] Use use_skill(action=list) anytime to view all tracking states",
  ],

  // 主动声明模式：不配 triggerEvent，配 triggerTool
  triggerTool: {
    extractMeta: (params) => {
      const name = params.name as string;
      const path = params.path as string | undefined;
      return {
        name,
        metadata: { skillMdPath: path ?? "" } satisfies SkillMeta,
        summary: `use_skill(start, name=${name})`,
      };
    },
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
  abandonThreshold: 20,
};
