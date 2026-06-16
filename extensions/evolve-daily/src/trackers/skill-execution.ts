/**
 * skill-execution Tracker 配置
 *
 * 从 skill-state 扩展迁移的第一个 Tracker 实例。
 * 追踪 skill 的加载、执行、异常、记录全生命周期。
 */

import { resolve, sep } from "node:path";

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

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
function extractSkillName(path: string): string | null {
  if (!path.endsWith("SKILL.md")) return null;
  const MIN_PATH_SEGMENTS = 2;
  const segments = path.replace(/\/$/, "").split("/");
  if (segments.length < MIN_PATH_SEGMENTS) return null;
  return segments[segments.length - MIN_PATH_SEGMENTS] ?? null;
}

/**
 * 判断 target 路径是否位于 cwd 之下（用于排除开发/调研场景的 SKILL.md read）。
 * target 可以是相对或绝对路径，统一 resolve 后比较前缀。
 */
function isPathInCwd(target: string, cwd: string): boolean {
  const abs = resolve(cwd, target);
  const prefix = cwd.endsWith(sep) ? cwd : cwd + sep;
  return abs === cwd || abs.startsWith(prefix);
}

// ── Steering 模板（从 skill-state/templates.ts 迁移）──

function loadedSteeringPrompt(name: string, id: number): string {
  return (
    `[SKILL-STATE] skill "${name}" loaded and tracking started (id=${id}).\n` +
    `When done, call skill_state(action=update, id=${id}, status=completed).\n` +
    `If blocked, call skill_state(action=update, id=${id}, status=error, detail="reason").\n` +
    `If this is a false positive (e.g. you only read SKILL.md for research/development, not to execute it), call skill_state(action=update, id=${id}, status=dismissed).`
  );
}

function remindSteeringPrompt(
  name: string,
  turnsSinceLoad: number,
): string {
  return `[SKILL-STATE][INFO] skill "${name}" loaded ${turnsSinceLoad} turns ago without reaching terminal state. Call skill_state to update (use status=dismissed if this was a research/development read).`;
}

function errorForceRecordPrompt(item: TrackedItem<SkillMeta>): string {
  return (
    `[SKILL-STATE][INFO] skill "${item.name}" reached ${item.errorCount} errors.\n` +
    `First consider: if these errors are false positives (the skill was not genuinely executed — e.g. you only read SKILL.md for research), call skill_state(action=update, id=${item.id}, status=dismissed) to stop tracking.\n` +
    `Only if the skill was genuinely executed and hit real issues, OPTIONALLY dispatch a subagent (background mode) to:\n` +
    `1. Read ${item.metadata.skillMdPath}\n` +
    `2. Analyze issues encountered during skill "${item.name}" execution based on current session context\n` +
    `3. Generate a structured issue record (skill name, error count, issue description, improvement suggestions)\n` +
    `Then call skill_state(action=update, id=${item.id}, status=recorded). Recording is optional, not mandatory.`
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
    "[Dismiss] If tracking is a false positive (research/development read, not execution), use update status=dismissed to stop reminders",
    "[Record] After 2 accumulated errors, issue recording is OPTIONAL — dismiss first if errors are false positives",
    "[Query] Use list anytime to view all tracking states",
  ],

  triggerEvent: "tool_call",
  triggerMatch: (event: unknown, ctx: ExtensionContext) => {
    const evt = event as Record<string, unknown>;
    if (evt.toolName !== "read") return null;
    const inputPath = evt.input &&
      typeof evt.input === "object" &&
      (evt.input as Record<string, unknown>).path;
    if (typeof inputPath !== "string") return null;

    const name = extractSkillName(inputPath);
    if (!name) return null;

    // 方向 A：排除 cwd 内的 SKILL.md。
    // 项目工作区内的 skill 源文件 read 多为开发/调研/改造，而非执行。
    // 全局 skill（~/.pi/agent/skills/、npm 包 skills/）不受影响。
    if (isPathInCwd(inputPath, ctx.cwd)) return null;

    return {
      name,
      metadata: { skillMdPath: inputPath } satisfies SkillMeta,
      summary: `read ${inputPath}`,
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
