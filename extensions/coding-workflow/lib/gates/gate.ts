/**
 * Gate Pipeline — 可配置的 gate 链，各 phase 声明自己的 gate 配置。
 * executeGateTool 按配置顺序执行 gate，任一失败则整体失败。
 */

import type { ChildProcess } from "node:child_process";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { PhaseConfig, WorkflowState } from "../helpers.js";
import type { SkillResolver } from "../skill-resolver.js";
import type { OnUpdateCallback } from "../subagent.js";

// ─── Gate interfaces ────────────────────────────────────

export interface Gate {
  /** Gate 名称，对应 PhaseConfig.gates 数组中的字符串 */
  readonly name: string;
  /** 执行 gate 检查 */
  run(ctx: GateContext): Promise<GateResult>;
}

export interface GateContext {
  /** 当前 phase 编号 */
  phase: number;
  /** topic 工作目录 */
  topicDir: string;
  /** 当前 workflow 状态 */
  state: WorkflowState;
  /** 当前 phase 的配置（从 PHASES 数组解析） */
  phaseConfig: PhaseConfig;
  /** Pi ExtensionAPI（用于 pi.__workflowRun / pi.__goalInit） */
  pi: ExtensionAPI;
  /** Skill 解析器 */
  skillResolver: SkillResolver;
  /** 外部 abort signal */
  signal?: AbortSignal;
  /** 更新回调（流式输出） */
  onUpdate?: OnUpdateCallback;
  /** 子进程注册表（用于 runSingleAgent 降级） */
  processRegistry?: ChildProcess[];
}

export interface GateResult {
  /** gate 是否通过 */
  passed: boolean;
  /** 未通过时的修复指引 */
  fixGuidance?: string;
  /** 详细信息（用于日志/调试） */
  details?: Record<string, unknown>;
}
