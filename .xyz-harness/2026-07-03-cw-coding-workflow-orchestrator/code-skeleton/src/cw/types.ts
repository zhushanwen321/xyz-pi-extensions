/**
 * CW 共享类型 + judgeByExpected 纯函数（D-004 内化自 test-orchestrator，#8 方案 A 等价迁移）。
 *
 * 变化轴：跨层共享的数据契约 + 测试判定密封逻辑。
 * 不依赖任何 cw 模块的运行时值（CwStore/GitValidator/GateRunner 仅 type-only 反向引用，
 * tsc 擦除，无运行时环）。
 */

// ── type-only 反向引用（构造 ActionDeps，无运行时环） ──
import type { CwStore } from "./store.js";
import type { GitValidator, GateRunner } from "./gates.js";

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
 */
export function judgeByExpected(
  expected: Expected,
  actual: Actual,
): { status: "passed" | "failed"; reason: string } {
  // 数据流：expected.url/text 存在则要求 actual 对应字段存在且 ===；任一不一致 → failed + 逐字段 reason。
  // 不变式：expected 无任何 judgeable 字段 → failed「no judgeable field」（plan-parser 应已拦，兜底）。
  // 竞态：无（纯函数）。SDK 契约：无。
  throw new Error("not implemented: judgeByExpected 逐字段 exact-match 比对（⑥Wave 落地）");
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

/** 注入依赖（composition root = index.ts 构造，测试可换 mock）。 */
export interface ActionDeps {
  store: CwStore;
  git: GitValidator;
  runner: GateRunner;
  workspacePath: string;
  topicDir: string;
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
