/**
 * TestOrchestrator 会话状态 — 闭包内创建，session 隔离。
 *
 * 一个 sessionId 对应一次 init(planPath) 调用。多 session 时各 session 的
 * orchestrator 状态互不可见（符合 Pi 多 session 隔离约束）。
 *
 * 状态机：每条用例 pending → in-progress → passed/failed。
 *   - pending：init 解析后初始态
 *   - in-progress：get 返回该用例给 AI 执行时标记
 *   - passed/failed：complete 时机器重算后落入（AI 填的 status 被丢弃）
 *
 * 文件职责：
 * - state.ts（本文件）: TestCase / TestSession 类型 + 工厂
 * - plan-parser.ts:       纯函数解析 plan.md E2E 表 → TestCase[]
 * - index.ts:             tool 注册 + 4 action + 机器重算 status
 */

// ── 用例状态机值 ─────────────────────────────────────────────

/** 用例终态（passed/failed）一旦落入不可回退——重跑需新 init。 */
export type CaseStatus = "pending" | "in-progress" | "passed" | "failed";

// ── Expected（机器判定的基准） ───────────────────────────────

/**
 * 机器判定的预期值。从 plan.md E2E 表「预期」列解析。
 *
 * 第一版只支持 url / text 两字段（exact match，见 handoff 风险点）：
 *   预期列写 `url=/profile, text=用户名` → { url: "/profile", text: "用户名" }
 *
 * 未来可扩展 domAttr / contains / regex，但当前 exact match 够用且最可靠
 * （模糊匹配是谎报温床——见 v4 设计「机器重算 status 的比对逻辑」风险点）。
 */
export interface Expected {
  /** 期望的页面 URL（exact match）。可选——纯断言类用例可能不关心 url。 */
  url?: string;
  /** 期望的页面文本内容（exact match）。可选——纯跳转类用例可能不关心 text。 */
  text?: string;
}

// ── Actual（AI 回传的真实观测值） ────────────────────────────

/**
 * AI 执行完用例后回传的真实观测值。由 browser skill / 测试框架抓取。
 *
 * 字段与 Expected 一一对应——complete 时机器逐字段比对：
 *   expected.url 存在 → actual.url 必须存在且 ===
 *   expected.text 存在 → actual.text 必须存在且 ===
 *
 * AI 摸不到判定逻辑——它只回传「我看到什么」，机器决定 pass/fail。
 */
export interface Actual {
  url?: string;
  text?: string;
  /** 可选的其他观测值（domAttr 等），第一版不参与判定但允许透传。 */
  [key: string]: unknown;
}

// ── TestCase（单条用例） ─────────────────────────────────────

/**
 * 一条 E2E 测试用例。init 时从 plan.md 解析生成，之后不可变（除 status）。
 */
export interface TestCase {
  /** 用例 ID（E1 / E1-r / E2 ...），plan.md 来。 */
  id: string;
  /** 测试层（mock / real），决定验收分组。 */
  layer: "mock" | "real";
  /** 场景描述（业务视角）。 */
  scenario: string;
  /** 前置条件。 */
  preconditions: string;
  /** 执行步骤（原始文本，AI 据此操作）。 */
  steps: string;
  /** 机器判定基准（解析自「预期」列）。 */
  expected: Expected;
  /** 执行方式（plan.md 来，供 AI 选择工具）。 */
  executor: string;
  // ── 运行时状态（init 后随 complete 推进） ──
  /** 当前状态。 */
  status: CaseStatus;
  /** complete 时回传的真实观测值（status 非 pending/in-progress 时有值）。 */
  actual?: Actual;
  /** complete 时回传的截图路径（机器校验过存在）。 */
  screenshotPath?: string;
  /** AI 填的 status（complete 入参，机器丢弃但留痕审计）。 */
  claimedStatus?: string;
  /** 机器判定失败时的原因（逐字段差异）。 */
  failureReason?: string;
}

// ── TestSession（一次 init 的全部状态） ──────────────────────

/**
 * 一次 init 创建的会话。含全部用例 + 元信息。
 * sessionId 是 soft 隔离——后续 action 必须带对，但不防恶意（恶意靠两道关防）。
 */
export interface TestSession {
  /** 会话 ID（init 生成）。 */
  sessionId: string;
  /** plan.md 绝对路径（init 入参）。 */
  planPath: string;
  /** 解析出的全部用例。 */
  cases: TestCase[];
  /** 创建时间戳（ISO）。 */
  createdAt: string;
}

// ── 工厂 ─────────────────────────────────────────────────────

/** 创建空会话壳（plan-parser 填 cases）。 */
export function createTestSession(sessionId: string, planPath: string): TestSession {
  return {
    sessionId,
    planPath,
    cases: [],
    createdAt: new Date().toISOString(),
  };
}

// ── 查询辅助（纯函数，供 action handler 和测试用） ───────────

/** 按 status 过滤用例。 */
export function casesByStatus(session: TestSession, status: CaseStatus): TestCase[] {
  return session.cases.filter((c) => c.status === status);
}

/** 按 id 查用例。 */
export function findCase(session: TestSession, caseId: string): TestCase | undefined {
  return session.cases.find((c) => c.id === caseId);
}

/** 是否全部终态（passed 或 failed）。 */
export function allTerminal(session: TestSession): boolean {
  return session.cases.every((c) => c.status === "passed" || c.status === "failed");
}

/** 是否全部 passed（get-result 门用）。 */
export function allPassed(session: TestSession): boolean {
  return session.cases.length > 0 && session.cases.every((c) => c.status === "passed");
}
