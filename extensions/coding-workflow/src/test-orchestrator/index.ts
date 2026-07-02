/**
 * test-orchestrator tool — 机器强制的 E2E 测试状态机。
 *
 * 防 AI 跳过/谎报 E2E 测试的核心机制（v4 设计）。4 个 action：
 *
 *   init(planPath)     → 机器解析 plan.md E2E 表，缓存用例+expected，返回 sessionId
 *   get(sessionId)     → 返回下一个 pending 用例 + 上下文，标记 in-progress
 *   complete(sessionId, caseId, actual, screenshotPath)
 *                       → 核心：机器校验截图存在 + 拿 expected 逐字段比对重算 status，
 *                         AI 填的 status 丢弃
 *   get-result(sessionId) → 收尾门：全覆盖 + 全 pass 才返回，否则 throw 阻塞
 *
 * 两道焊死的关（防谎报 + 防跳过）：
 *   1. complete 的 typebox schema 强制 actual 非空 + screenshotPath 必填 → 缺则 tool 层 throw
 *   2. get-result 校验全 completed + 全 pass → 否则 throw
 *
 * 状态计算（最关键）：
 *   AI 传 actual（真实观测值）+ screenshotPath
 *   机器读 init 缓存的 expected（plan 解析来的）
 *   机器逐字段比对 → pass/fail。AI 摸不到判定逻辑。
 *
 * 文件职责：
 * - state.ts:       TestCase / TestSession 类型 + 工厂 + 查询辅助
 * - plan-parser.ts: plan.md E2E 表 → TestCase[]（纯函数）
 * - index.ts（本文件）: tool 注册 + 4 action handler + 机器重算 status + 状态存储
 *
 * DESIGN NOTE — 为什么用 Map 存 session 而非 ctx.sessionManager？
 *   sessionManager 是 Pi 全局 entry 存储，多扩展共用。test-orchestrator 的
 *   sessionId 是业务概念（一次 plan 一组测试），与 Pi session 概念正交。
 *   用闭包内 Map<sessionId, TestSession> 既满足 session 隔离（闭包内），又避免
 *   污染全局 entry 流。GC 由 maxSessions 驱逐最老的实现（防长跑 session 积累）。
 */

import nodeFs from "node:fs";
import nodePath from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

import { parseE2ECases } from "./plan-parser.js";
import {
  type Actual,
  allPassed,
  allTerminal,
  casesByStatus,
  type CaseStatus,
  createTestSession,
  type Expected,
  findCase,
  type TestCase,
  type TestSession,
} from "./state.js";

// ── 常量 ─────────────────────────────────────────────────────

/** 闭包内 session 上限（LRU 驱逐，防长跑积累）。 */
const MAX_SESSIONS = 8;

// ── Tool result details 类型 ─────────────────────────────────

interface OrchestratorDetails {
  action: "init" | "get" | "complete" | "get-result";
  sessionId: string;
  cases: TestCase[];
  [key: string]: unknown;
}

// ── typebox schema（两道关之一：complete 强制 actual + screenshotPath） ──

const ActualSchema = Type.Object({
  url: Type.Optional(Type.String({ description: "观测到的页面 URL" })),
  text: Type.Optional(Type.String({ description: "观测到的页面文本" })),
});

const TestOrchestratorParams = Type.Object({
  action: StringEnum(["init", "get", "complete", "get-result"] as const),
  sessionId: Type.Optional(
    Type.String({ description: "会话 ID（get/complete/get-result 必填，init 返回）" }),
  ),
  planPath: Type.Optional(
    Type.String({ description: "plan.md 绝对路径（init 必填）" }),
  ),
  caseId: Type.Optional(
    Type.String({ description: "用例 ID（complete 必填）" }),
  ),
  // 关 1：complete 必填 actual 非空对象
  actual: Type.Optional(ActualSchema),
  // 关 1：complete 必填 screenshotPath
  screenshotPath: Type.Optional(
    Type.String({ description: "截图绝对路径（complete 必填，机器校验存在）" }),
  ),
  // AI 填的 status —— 机器丢弃，仅留痕审计
  claimedStatus: Type.Optional(
    Type.String({ description: "AI 声称的状态（机器忽略，仅审计）" }),
  ),
});

type OrchestratorParams = Static<typeof TestOrchestratorParams>;

// ── 闭包状态工厂 ─────────────────────────────────────────────

/**
 * 创建 orchestrator 闭包状态。每个 Pi session 一个实例（session 隔离）。
 *
 * Map<sessionId, TestSession> 是核心存储。LRU 驱逐防积累：
 * 超过 MAX_SESSIONS 时删最老的（按 createdAt 排序）。
 */
interface OrchestratorStore {
  sessions: Map<string, TestSession>;
}

function createStore(): OrchestratorStore {
  return { sessions: new Map() };
}

// ── session 存取辅助 ─────────────────────────────────────────

/** 取 session，不存在抛错（业务约束：必须先 init）。 */
function requireSession(store: OrchestratorStore, sessionId: string): TestSession {
  const session = store.sessions.get(sessionId);
  if (!session) {
    throw new Error(`session not found: ${sessionId} (run init first)`);
  }
  return session;
}

/** 存 session，超限时驱逐最老的。 */
function putSession(store: OrchestratorStore, session: TestSession): void {
  if (store.sessions.size >= MAX_SESSIONS && !store.sessions.has(session.sessionId)) {
    evictOldest(store);
  }
  store.sessions.set(session.sessionId, session);
}

/** 驱逐最老 session（按 createdAt）。 */
function evictOldest(store: OrchestratorStore): void {
  let oldestId: string | undefined;
  let oldestTime = Infinity;
  for (const [id, s] of store.sessions) {
    const t = new Date(s.createdAt).getTime();
    if (t < oldestTime) {
      oldestTime = t;
      oldestId = id;
    }
  }
  if (oldestId) store.sessions.delete(oldestId);
}

/** sessionId 随机后缀长度（碰撞保护）。 */
const SESSION_ID_RANDOM_LENGTH = 8;

/** base36 编码（toString 参数：0-9 + a-z）。 */
const RADIX_BASE36 = 36;

/** Math.random().toString(36) 输出 "0.xxx"，前导 "0." 长度需跳过。 */
const RANDOM_PREFIX_LENGTH = 2;

/** 生成 sessionId。 */
function generateSessionId(): string {
  const start = RANDOM_PREFIX_LENGTH;
  const random = Math.random()
    .toString(RADIX_BASE36)
    .slice(start, start + SESSION_ID_RANDOM_LENGTH);
  return `to-${Date.now().toString(RADIX_BASE36)}-${random}`;
}

// ── action: init ─────────────────────────────────────────────

/**
 * init: 读 plan.md → 解析 E2E 表 → 创建 session → 返回 sessionId。
 *
 * 失败模式（throw）：
 *   - planPath 缺失
 *   - 文件不存在 / 读失败
 *   - 解析零用例（plan 无 E2E 表或格式错）
 */
function actionInit(store: OrchestratorStore, params: OrchestratorParams): OrchestratorDetails {
  if (!params.planPath) {
    throw new Error("init requires planPath parameter");
  }
  const planPath = nodePath.resolve(params.planPath);

  let markdown: string;
  try {
    markdown = nodeFs.readFileSync(planPath, "utf-8");
  } catch (e) {
    throw new Error(`cannot read plan: ${planPath} — ${(e as Error).message}`);
  }

  const { cases, errors } = parseE2ECases(markdown);
  if (cases.length === 0) {
    throw new Error(
      `no E2E cases parsed from plan${errors.length ? ` (${errors.join("; ")})` : ""}`,
    );
  }

  const session = createTestSession(generateSessionId(), planPath);
  session.cases = cases;
  putSession(store, session);

  return {
    action: "init",
    sessionId: session.sessionId,
    cases,
    parsedCount: cases.length,
    parseWarnings: errors,
  };
}

// ── action: get ──────────────────────────────────────────────

/**
 * get: 返回下一个 pending 用例 + 执行上下文，标记 in-progress。
 *
 * 策略：取第一个 pending（保序）。无 pending 时：
 *   - 有 in-progress → 返回提示（有未 complete 的）
 *   - 全终态 → 返回提示（调 get-result 收尾）
 */
function actionGet(store: OrchestratorStore, params: OrchestratorParams): OrchestratorDetails {
  const session = requireSession(store, requireParam<string>(params, "sessionId"));
  const pending = casesByStatus(session, "pending");
  const inProgress = casesByStatus(session, "in-progress");

  if (pending.length === 0) {
    // 无 pending——返回当前状态快照，调用方据 in-progress/终态数决策
    return {
      action: "get",
      sessionId: session.sessionId,
      cases: session.cases,
      nextCase: null,
      message:
        inProgress.length > 0
          ? `${inProgress.length} case(s) in-progress, call complete for them first`
          : "all cases terminal, call get-result to finalize",
    };
  }

  const next = pending[0]!;
  next.status = "in-progress";

  return {
    action: "get",
    sessionId: session.sessionId,
    cases: session.cases,
    nextCase: next,
  };
}

// ── action: complete（核心：机器重算 status） ───────────────

/**
 * complete: 校验截图 + 拿 expected 逐字段比对 actual → 重算 status。
 *
 * 两道关之一（防谎报）：
 *   - typebox schema 强制 actual 必填（结构化对象）+ screenshotPath 必填
 *   - 运行时再校验截图文件真实存在（fs.existsSync）
 *
 * AI 填的 claimedStatus **丢弃**——仅留痕审计。机器重算：
 *   expected.url 存在 → actual.url 必须存在且 ===
 *   expected.text 存在 → actual.text 必须存在且 ===
 *   任一字段不匹配 → failed + failureReason
 *   全匹配 → passed
 */
function actionComplete(
  store: OrchestratorStore,
  params: OrchestratorParams,
): OrchestratorDetails {
  const session = requireSession(store, requireParam<string>(params, "sessionId"));
  const caseId = requireParam<string>(params, "caseId");
  const actual = requireParam<Actual>(params, "actual");
  const screenshotPath = requireParam<string>(params, "screenshotPath");

  const testCase = findCase(session, caseId);
  if (!testCase) {
    throw new Error(`case not found: ${caseId} (session ${session.sessionId})`);
  }
  if (testCase.status === "passed" || testCase.status === "failed") {
    throw new Error(
      `case ${caseId} already terminal (${testCase.status}) — init new session to re-run`,
    );
  }

  // 关 1（运行时）：截图必须真实存在
  verifyScreenshot(screenshotPath);

  // 关 2（核心）：机器重算 status，AI 的 claimedStatus 丢弃
  const { status, reason } = judgeByExpected(testCase.expected, actual);

  testCase.status = status;
  testCase.actual = actual;
  testCase.screenshotPath = screenshotPath;
  testCase.claimedStatus = params.claimedStatus;
  if (status === "failed") {
    testCase.failureReason = reason;
  }

  return {
    action: "complete",
    sessionId: session.sessionId,
    cases: session.cases,
    completedCase: testCase,
    machineVerdict: status,
    ...(status === "failed" ? { failureReason: reason } : {}),
  };
}

/** 校验截图文件存在（防谎报：路径假则 throw）。 */
function verifyScreenshot(screenshotPath: string): void {
  if (!nodeFs.existsSync(screenshotPath)) {
    throw new Error(
      `screenshot not found: ${screenshotPath} (complete requires existing screenshot)`,
    );
  }
}

// ── action: get-result（收尾门，防跳过） ────────────────────

/**
 * get-result: 全覆盖 + 全 pass 才返回，否则 throw（阻塞 goal complete）。
 *
 * 关 2（防跳过）：
 *   - 有非终态用例（pending/in-progress）→ throw（要求 complete 完）
 *   - 有 failed 用例 → throw（要求修复后重跑，或显式放弃另起 session）
 *   - 全 passed → 返回汇总
 */
function actionGetResult(
  store: OrchestratorStore,
  params: OrchestratorParams,
): OrchestratorDetails {
  const session = requireSession(store, requireParam<string>(params, "sessionId"));

  if (!allTerminal(session)) {
    const pending = casesByStatus(session, "pending");
    const inProgress = casesByStatus(session, "in-progress");
    throw new Error(
      `coverage gate FAILED: ${pending.length} pending + ${inProgress.length} in-progress ` +
        `(${session.cases.length} total). Complete all cases before get-result.`,
    );
  }

  if (!allPassed(session)) {
    const failed = casesByStatus(session, "failed");
    throw new Error(
      `result gate FAILED: ${failed.length} of ${session.cases.length} case(s) failed. ` +
        `Fix and re-run via new init, or failed cases:\n${formatFailedList(failed)}`,
    );
  }

  return {
    action: "get-result",
    sessionId: session.sessionId,
    cases: session.cases,
    passed: true,
    totalCases: session.cases.length,
    summary: `all ${session.cases.length} E2E case(s) passed`,
  };
}

// ── 机器重算 status（核心判定逻辑，纯函数可测） ─────────────

/**
 * 拿 expected 逐字段比对 actual，重算 status。
 *
 * 规则（exact match，第一版）：
 *   - expected.url 存在：actual.url 必须存在且 ===
 *   - expected.text 存在：actual.text 必须存在且 ===
 *   - expected 无任何字段（理论上 plan-parser 已拦，兜底）：判 failed「无可判定字段」
 *   - 全匹配 → passed
 *
 * 返回 { status, reason }。reason 仅 failed 时有意义。
 */
export function judgeByExpected(
  expected: Expected,
  actual: Actual,
): { status: CaseStatus; reason: string } {
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

  if (expected.url === undefined && expected.text === undefined) {
    // 兜底：plan-parser 应已拦，但 judge 是公共导出可能被直接调
    return { status: "failed", reason: "no judgeable field in expected (url/text)" };
  }

  if (mismatches.length > 0) {
    return { status: "failed", reason: mismatches.join("; ") };
  }
  return { status: "passed", reason: "" };
}

// ── 辅助 ─────────────────────────────────────────────────────

/** 取必填参数，缺失抛错。泛型 T 让调用方声明期望类型（调用方负责保证 typebox schema 一致）。 */
function requireParam<T>(params: OrchestratorParams, name: keyof OrchestratorParams): T {
  const value = params[name];
  if (value === undefined || value === null) {
    throw new Error(`missing required parameter: ${name}`);
  }
  return value as T;
}

/** 格式化失败用例列表（get-result 错误信息用）。 */
function formatFailedList(failed: TestCase[]): string {
  return failed
    .map((c) => `  - ${c.id} [${c.layer}]: ${c.failureReason ?? "unknown"}`)
    .join("\n");
}

// ── Tool 注册入口 ────────────────────────────────────────────

/** 注册 test-orchestrator tool。闭包 store 保证 session 隔离。 */
export function registerTestOrchestratorTool(pi: ExtensionAPI): OrchestratorStore {
  const store = createStore();

  pi.registerTool({
    name: "test-orchestrator",
    label: "Test Orchestrator",
    description:
      "Machine-enforced E2E test state machine. Prevents AI from skipping or " +
      "falsifying E2E tests.\n\nActions:\n" +
      "- init(planPath): parse plan.md E2E table, cache cases+expected, return sessionId\n" +
      "- get(sessionId): return next pending case + context, mark in-progress\n" +
      "- complete(sessionId, caseId, actual, screenshotPath): machine-verifies screenshot " +
      "exists + re-computes pass/fail from expected (AI's claimed status is ignored)\n" +
      "- get-result(sessionId): finalize gate — all cases must be completed + all passed, " +
      "else throws to block goal completion",
    promptSnippet:
      "Use during coding-execute to run E2E tests with machine-verifiable results. " +
      "The tool re-computes pass/fail from the plan's expected values — you cannot self-declare.",
    promptGuidelines: [
      "[强制] coding-execute 阶段 E2E 用例必须经此 tool，禁止自标 manual/blocked",
      "[防谎报] complete 必须传真实观测值 actual + 截图路径（机器校验存在）",
      "[防跳过] get-result 要求全用例 completed 且全 passed，否则 throw",
      "[机器重算] 你填的 status 被丢弃，机器按 plan 的 expected 逐字段比对",
      "[状态机] pending → in-progress → passed/failed，终态不可回退",
    ],
    executionMode: "sequential",
    parameters: TestOrchestratorParams,

    // execute 签名：(toolCallId, params, signal, onUpdate, ctx)
    async execute(
      _toolCallId: string,
      params: Static<typeof TestOrchestratorParams>,
      signal: AbortSignal | undefined,
    ) {
      if (signal?.aborted) throw new Error("test-orchestrator call aborted by signal.");

      const details = dispatch(store, params as OrchestratorParams);

      return {
        content: [{ type: "text" as const, text: renderSummary(details) }],
        details,
      };
    },
  });

  return store;
}

// ── dispatcher ───────────────────────────────────────────────

/** action 路由。各 action handler 独立，失败直接 throw。 */
function dispatch(
  store: OrchestratorStore,
  params: OrchestratorParams,
): OrchestratorDetails {
  switch (params.action) {
    case "init":
      return actionInit(store, params);
    case "get":
      return actionGet(store, params);
    case "complete":
      return actionComplete(store, params);
    case "get-result":
      return actionGetResult(store, params);
    default:
      throw new Error(`unknown action: ${params.action as string}`);
  }
}

// ── 渲染（content 文本，TUI 展示用） ─────────────────────────

/** 渲染 tool result 摘要文本（content 字段）。 */
function renderSummary(details: OrchestratorDetails): string {
  const lines: string[] = [];
  const statusCount = countByStatus(details.cases);

  switch (details.action) {
    case "init":
      lines.push(`[test-orchestrator] session ${details.sessionId} initialized`);
      lines.push(`  parsed ${String(details.cases.length)} E2E case(s) from plan`);
      if (details.parseWarnings && (details.parseWarnings as string[]).length > 0) {
        lines.push(`  warnings: ${(details.parseWarnings as string[]).join("; ")}`);
      }
      break;
    case "get": {
      const next = details.nextCase as TestCase | null;
      if (next) {
        lines.push(`[test-orchestrator] next case: ${next.id} [${next.layer}]`);
        lines.push(`  scenario: ${next.scenario}`);
        lines.push(`  steps: ${next.steps}`);
        lines.push(`  expected: ${formatExpected(next.expected)}`);
        lines.push(`  executor: ${next.executor}`);
      } else {
        lines.push(`[test-orchestrator] ${details.message as string}`);
      }
      break;
    }
    case "complete": {
      const completed = details.completedCase as TestCase;
      lines.push(
        `[test-orchestrator] ${completed.id} → ${details.machineVerdict as string}`,
      );
      if (details.machineVerdict === "failed") {
        lines.push(`  reason: ${details.failureReason as string}`);
      }
      break;
    }
    case "get-result":
      lines.push(
        `[test-orchestrator] result: ${details.passed ? "ALL PASSED" : "BLOCKED"} ` +
          `(${String(details.totalCases as number)} cases)`,
      );
      break;
  }

  lines.push(formatStatusLine(statusCount));
  return lines.join("\n");
}

/** 格式化 status 计数行。 */
function formatStatusLine(count: Record<CaseStatus, number>): string {
  return `  [pending:${count.pending ?? 0} in-progress:${count["in-progress"] ?? 0} ` +
    `passed:${count.passed ?? 0} failed:${count.failed ?? 0}]`;
}

/** 按状态分组计数。 */
function countByStatus(cases: TestCase[]): Record<CaseStatus, number> {
  const count: Record<CaseStatus, number> = {
    pending: 0,
    "in-progress": 0,
    passed: 0,
    failed: 0,
  };
  for (const c of cases) {
    count[c.status]++;
  }
  return count;
}

/** 格式化 Expected（get 输出用）。 */
function formatExpected(expected: Expected): string {
  const parts: string[] = [];
  if (expected.url !== undefined) parts.push(`url=${expected.url}`);
  if (expected.text !== undefined) parts.push(`text=${expected.text}`);
  return parts.join(", ") || "(no judgeable field)";
}
