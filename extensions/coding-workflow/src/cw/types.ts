/**
 * CW 共享类型 + judgeByExpected 纯函数（D-004 内化自 test-orchestrator，#8 方案 A 等价迁移）。
 *
 * 变化轴：跨层共享的数据契约 + 测试判定密封逻辑。
 * 不依赖任何 cw 模块的运行时值（CwStore/GitValidator/GateRunner 仅 type-only 反向引用，
 * tsc 擦除，无运行时环）。
 */

// ── type-only 反向引用（构造 ActionDeps，无运行时环） ──
import { join } from "node:path";

import type { GateRunner,GitValidator } from "./gates.js";
import type { CwStore } from "./store.js";

// ── 状态机值对象 ────────────────────────────────────────────

export type CwStatus =
  | "created"
  | "planned"
  | "clarified"
  | "detailed"
  | "developed"
  | "tested"
  | "retrospected"
  | "closed";

export type Tier = "lite" | "mid";

export type GateTier = "weak-structural" | "medium-git" | "medium-coverage" | "strong-recompute";

export type CwAction =
  | "create"
  | "plan"
  | "clarify"
  | "detail"
  | "dev"
  | "test"
  | "retrospect"
  | "closeout";

// ── judgeByExpected 密封判定（内化自 test-orchestrator/state.ts） ──

/** 机器判定基准（lite plan.json 结构化字段）。 */
export interface Expected {
  url?: string;
  text?: string;
}

/** agent 回传的真实观测值（与 Expected 逐字段比对）。 */
export interface Actual {
  url?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * 拿 expected 逐字段 exact-match 比对 actual，重算 status（D-008 strong-recompute）。
 *
 * AI 的 claimedStatus 在调用方（test handler lite 分支）丢弃——本函数只看 expected/actual。
 * 迁移自 test-orchestrator/index.ts，8 条测试用例等价（来源 0，#8 AC-8.1）。
 *
 * 叶子逻辑：骨架阶段签名已定，逐字段比对体留 ⑥Wave 实现。
 *
 * 匹配严格度（m-4）：**精确字符串相等**，不做 fuzzy/substring/trim 容差。
 * 设计取舍——lite test 是机器重算门，意图是防 AI 谎报。若加 trim/substring 容差，
 * AI 可用「几乎一样」蒙混（如末尾斜杠、空格、大小写差异）。零容差强制 AI 在 plan 阶段
 * 写出与实际完全一致的 expected。代价：expected 写得不严谨会导致 valid 测试 FAIL，
 * 但这是设计意图（plan 阶段不应产出模糊 expected）。
 */
export function judgeByExpected(
  expected: Expected,
  actual: Actual,
): { status: "passed" | "failed"; reason: string } {
  // 数据流：expected.url/text 存在则要求 actual 对应字段存在且 ===；任一不一致 → failed + 逐字段 reason。
  // 不变式：expected 无任何 judgeable 字段 → failed「no judgeable field」（plan-parser 应已拦，兜底）。
  // 竞态：无（纯函数）。SDK 契约：无。
  const mismatches: string[] = [];

  if (expected.url !== undefined) {
    if (actual.url === undefined) {
      mismatches.push(`url missing (expected "${expected.url}")`);
    } else if (actual.url !== expected.url) {
      mismatches.push(`url: "${actual.url}" !== "${expected.url}"`);
    }
  }

  if (expected.text !== undefined) {
    if (actual.text === undefined) {
      mismatches.push(`text missing (expected "${expected.text}")`);
    } else if (actual.text !== expected.text) {
      mismatches.push(`text: "${actual.text}" !== "${expected.text}"`);
    }
  }

  // 兜底：plan-parser 应已拦截空 expected，但 judge 是公共导出可能被直接调用。
  if (expected.url === undefined && expected.text === undefined) {
    return { status: "failed", reason: "no judgeable field in expected (url/text)" };
  }

  if (mismatches.length > 0) {
    return { status: "failed", reason: mismatches.join("; ") };
  }
  return { status: "passed", reason: "" };
}

// ── 领域模型（DAO 拼装，§8 architecture） ────────────────────

export interface Wave {
  id: string;
  dependsOn: string[];
  parallelGroup?: string;
  committed: string | null;
  changes: string[];
  issues: string[];
}

export interface TestCase {
  id: string;
  layer: "mock" | "real" | "unit" | "integration" | "e2e" | "perf-chaos";
  scenario: string;
  steps: string;
  expected?: Expected;
  assertion?: string;
  executor: string;
  status: "pending" | "passed" | "failed";
  actual?: Actual;
  screenshotPath?: string;
  commitHash?: string;
  judgedAt?: string;
  failureReason?: string;
  /**
   * lite 专属：plan 阶段声明本用例是否要求 screenshotPath。
   * cw test lite 分支据此判断（requiresScreenshot=true 且 submission 缺 screenshot → failed）。
   * mid 路径不使用此字段（mid 用 commitHash + claimedStatus，不要求 screenshot）。
   */
  requiresScreenshot?: boolean;
}

export interface GateHistoryEntry {
  id: number;
  phase: CwAction;
  action: CwAction;
  gate: string;
  tier: GateTier;
  result: "pass" | "fail";
  ts: string;
  report?: string;
  progressive: boolean;
}

export interface Evidence {
  closedAt: string;
  coverage?: number;
  gateHistory: GateHistoryEntry[];
}

/** 应用层逻辑模型（DAO 从 4 张 sqlite 表拼装）。 */
export interface CwTopic {
  schemaVersion: number;
  topicId: string;
  slug: string;
  tier: Tier;
  objective: string;
  workspacePath: string;
  /** 交付物目录（= workspacePath/.xyz-harness/{slug}）。create 时算好存入，后续 action + check 函数用它定位 plan.md/changes/ 等。修复 ROOT-01：原 index.ts 把 topicDir 赋成 workspacePath 导致所有读盘 gate 在项目根查找而永远 FAIL。 */
  topicDir: string;
  createdAt: string;
  status: CwStatus;
  planFormat?: "lite" | "mid-clarify" | "mid-detail";
  waves: Wave[];
  testCases: TestCase[];
  gateHistory: GateHistoryEntry[];
  /** topic 表 gate_passed JSON 列拼装；第三重 guard 重算与此比对。 */
  gatePassed: Partial<Record<CwAction, boolean>>;
  evidence?: Evidence;
  coverage?: number;
}

// ── DAO 写入用 seed（insert 方法入参） ──────────────────────

export interface WaveSeed {
  id: string;
  dependsOn: string[];
  parallelGroup?: string;
  changes: string[];
  issues: string[];
}

export interface TestCaseSeed {
  id: string;
  layer: TestCase["layer"];
  scenario: string;
  steps: string;
  expected?: Expected;
  assertion?: string;
  executor: string;
  /** lite 专属：见 TestCase.requiresScreenshot。mid seed 不填（undefined 视为 false）。 */
  requiresScreenshot?: boolean;
}

export interface GateHistorySeed {
  phase: CwAction;
  action: CwAction;
  gate: string;
  tier: GateTier;
  result: "pass" | "fail";
  report?: string;
  progressive: boolean;
}

// ── guard 返回（DESIGN-IT-TWICE Agent2：不 throw，返回 Verdict） ──

export type GuardErrorCode = "illegal_transition" | "phase_incomplete" | "cache_inconsistent";

export type GuardVerdict = { ok: true } | { ok: false; code: GuardErrorCode; reason: string };

// ── nextAction（#9 扁平结构） ────────────────────────────────

export interface NextAction {
  action?: CwAction;
  skill?: string;
  guidance: string;
  waves?: Array<{ id: string; committed: boolean }>;
  testCases?: Array<{ id: string; status: TestCase["status"] }>;
}

// ── action handler 契约 ─────────────────────────────────────

/**
 * 注入依赖（composition root = index.ts 构造，测试可换 mock）。
 * git/runner 是 gates.ts 的 adapter 类型（type-only 反向引用，tsc 擦除无运行时环）。
 */
export interface ActionDeps {
  store: CwStore;
  git: GitValidator;
  runner: GateRunner;
  workspacePath: string;
}

/**
 * 从 topic 记录推导 GateContext.topicDir（各 action handler loadTopic 后调用）。
 *
 * create 时已把 topicDir 算好存入 topic.topicDir，handler 直接用即可。本函数作 fallback
 * 兜底旧库（topic_dir 列 NULL 时从 workspacePath + slug 重算）。
 */
export function resolveTopicDir(topic: CwTopic): string {
  return topic.topicDir || join(topic.workspacePath, ".xyz-harness", topic.slug);
}

/** handler 统一返回。各 action 可附加专属字段（devProgress/testProgress 等）。 */
export interface ActionResult {
  topicId: string;
  status: CwStatus;
  gatePassed: Partial<Record<CwAction, boolean>>;
  gateTier?: GateTier;
  gateHistoryEntry?: GateHistoryEntry;
  nextAction: NextAction;
  [key: string]: unknown;
}
