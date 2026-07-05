/**
 * CW tool 注册入口 + dispatch（D-001 tool 实现，§9.3 内化 step5）。
 *
 * 取代 registerTestOrchestratorTool。单个 tool `coding-workflow`，参数 action 路由到 8 handler。
 * composition root：构造 ActionDeps（store/git/runner），按 topic workspacePath 定位。
 *
 * 错误模式（项目规范）：handler throw new Error，Pi 捕获转述 agent。不返回伪装成功 content。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { type ClarifyParams,handleClarify } from "./cw/actions/clarify.js";
import { type CloseoutParams,handleCloseout } from "./cw/actions/closeout.js";
import { type CreateParams,handleCreate } from "./cw/actions/create.js";
import { type DetailParams,handleDetail } from "./cw/actions/detail.js";
import { type DevParams,handleDev } from "./cw/actions/dev.js";
import { handlePlan, type PlanParams } from "./cw/actions/plan.js";
import { handleRetrospect, type RetrospectParams } from "./cw/actions/retrospect.js";
import { handleTest, type TestParams } from "./cw/actions/test.js";
import { GateRunner, GitValidator } from "./cw/gates.js";
import {
  LitePlanSchema,
  MidClarifySchema,
  MidDetailSchema,
  TestCaseSubmissionSchema,
} from "./cw/plan-parser.js";
import { CwStore } from "./cw/store.js";
import type { ActionDeps, ActionResult } from "./cw/types.js";

// ── typebox schema（tool 入参，Pi 运行时校验） ───────────────

// 3 个 JSON 字段（planJson/clarifyJson/detailJson）直接引用 plan-parser.ts 的 schema：
//   - 单一来源（DRY）：tool 层和 parser 层共用同一 schema 定义，不会漂移
//   - LLM 看到完整字段结构（id/scenario/expected/...），减少字段名猜错
//   - format 字段两层都校验（tool 层 Literal 锁 + parser 层 assertFormat），冗余但安全
// 每个 JSON 字段对应确定的 schema，不需要 union：
//   planJson 只走 lite 路径（action=plan → tier=lite，state-machine.ts:228）
//   clarifyJson 只走 mid clarify，detailJson 只走 mid detail
// cases 引用 TestCaseSubmissionSchema（caseId 必填 + lite/mid 分支字段 optional）。
const CwParamsSchema = Type.Object({
  action: StringEnum([
    "create", "plan", "clarify", "detail", "dev", "test", "retrospect", "closeout",
  ] as const),
  // 通用定位
  topicId: Type.Optional(Type.String()),
  // create
  slug: Type.Optional(Type.String()),
  tier: Type.Optional(StringEnum(["lite", "mid"] as const)),
  objective: Type.Optional(Type.String()),
  workspacePath: Type.Optional(Type.String()),
  // plan：lite plan.json（action=plan 只走 lite，format 锁定 "lite"）
  planJson: Type.Optional(LitePlanSchema),
  // clarify：mid clarify.json（action=clarify 只走 mid，format 锁定 "mid-clarify"）
  clarifyJson: Type.Optional(MidClarifySchema),
  // detail：mid detail.json（action=detail 只走 mid，format 锁定 "mid-detail"）
  detailJson: Type.Optional(MidDetailSchema),
  // dev（D-005 数组，长1=单个/N=批量）
  tasks: Type.Optional(Type.Array(Type.Object({
    waveId: Type.String(),
    commitHash: Type.String(),
  }))),
  // test（D-005 数组，元素结构跨 lite/mid 分支，test.ts 内部按 tier 校验 actual/commitHash）
  cases: Type.Optional(Type.Array(TestCaseSubmissionSchema)),
  // retrospect
  retrospectPath: Type.Optional(Type.String()),
});

export type CwParams = {
  action: "create" | "plan" | "clarify" | "detail" | "dev" | "test" | "retrospect" | "closeout";
  topicId?: string;
  slug?: string;
  tier?: "lite" | "mid";
  objective?: string;
  workspacePath?: string;
  /** LitePlanSchema 静态类型派生（format:"lite" + waves + testCases）。 */
  planJson?: object;
  /** MidClarifySchema 静态类型（format:"mid-clarify" + deliverables）。 */
  clarifyJson?: object;
  /** MidDetailSchema 静态类型（format:"mid-detail" + waves + testCases + deliverables）。 */
  detailJson?: object;
  tasks?: Array<{ waveId: string; commitHash: string }>;
  /** TestCaseSubmissionSchema 静态类型（caseId + lite/mid 分支 optional 字段）。 */
  cases?: Array<{ caseId: string; actual?: object; screenshotPath?: string; commitHash?: string; claimedStatus?: "passed" | "failed" }>;
  retrospectPath?: string;
};

// ── dispatch（action → handler 路由） ────────────────────────

export function dispatch(params: CwParams, deps: ActionDeps): ActionResult {
  switch (params.action) {
    case "create":
      return handleCreate(params as CreateParams, deps);
    case "plan":
      return handlePlan(params as PlanParams, deps);
    case "clarify":
      return handleClarify(params as ClarifyParams, deps);
    case "detail":
      return handleDetail(params as DetailParams, deps);
    case "dev":
      return handleDev(params as DevParams, deps);
    case "test":
      return handleTest(params as TestParams, deps);
    case "retrospect":
      return handleRetrospect(params as RetrospectParams, deps);
    case "closeout":
      return handleCloseout(params as CloseoutParams, deps);
    default:
      throw new Error(`unknown action: ${(params as { action?: string }).action}`);
  }
}

// ── tool 注册 ────────────────────────────────────────────────

/**
 * 注册单个 tool `coding-workflow`（D-001）。
 * execute 内构造 ActionDeps（composition root）+ dispatch 到 8 handler 之一。
 */
export function registerCodingWorkflowTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "coding-workflow",
    label: "Coding Workflow Orchestrator",
    description: [
      "Use when starting or advancing a structured coding task that must go through the CW state machine:",
      "create → plan|clarify → detail → dev → test → retrospect → closeout.",
      "CW is the SOLE authority for coding-flow state transitions + gate verification (D-001/D-002).",
      "",
      "WHEN TO USE (按当前 topic status 选 action):",
      "- status=created (lite) → action=plan; status=created (mid) → action=clarify",
      "- status=clarified (mid) → action=detail",
      "- status=planned|detailed → action=dev (progressive commit submission)",
      "- status=developed → action=test (progressive result submission)",
      "- status=tested → action=retrospect; status=retrospected → action=closeout",
      "Each call returns nextAction — ALWAYS follow it; do not self-decide the next phase.",
      "dev/test/retrospect 支持渐进式重提交（gate fail 后 status 已流转仍可重调同 action 补提交，",
      "直到 gatePassed）。",
      "",
      "WHEN NOT TO USE (反模式):",
      "- Do NOT call goal_control(complete) to skip CW — goal complete 只查 evidence 字符串非空，",
      "  不校验 CW 状态。绕过 CW = 状态机不流转，后续 action 全 throw illegal_transition。",
      "- Do NOT call dev/test before their gate passes — CW guard throws illegal_transition,",
      "  the call fails and no state mutates.",
      "- Do NOT use CW to dispatch subagents, run tests, or write code — CW only verifies gates +",
      "  advances status. Execution is agent's job (guided by coding-execute skill).",
      "- Do NOT change tier after create — tier is locked (D-003). Wrong tier = tear down topic +",
      "  recreate, not in-flight downgrade.",
      "",
      "PARAMETERS BY ACTION:",
      "- create: slug + tier + objective (+workspacePath?)",
      "- plan: topicId + planJson",
      "- clarify: topicId + clarifyJson",
      "- detail: topicId + detailJson",
      "- dev: topicId + tasks[{waveId, commitHash}]",
      "- test: topicId + cases[{caseId, actual?, screenshotPath?, commitHash?, claimedStatus?}]",
      "- retrospect: topicId + retrospectPath",
      "- closeout: topicId",
      "",
      "CAPABILITY BOUNDARY — you cannot use CW to:",
      "- Run tests / build / lint (use BashTool or dispatch test-runner subagent)",
      "- Dispatch implementer/reviewer subagents (use subagent tool, guided by coding-execute skill)",
      "- Mutate goal/todo state (use goal_control / todo tools — CW is upper orchestrator, not lower)",
      "- Parse plan.md/execution-plan.md markdown (CW consumes structured JSON: plan.json/clarify.json/detail.json)",
      "",
      "TOOLCHAIN: CW reads nextAction from the PREVIOUS call's return value. Never guess the next",
      "action — if last call returned nextAction.action=\"dev\", the next CW call MUST be action=dev.",
      "lite test = strong-recompute (CW re-judges actual vs expected, drops claimedStatus, D-008);",
      "mid test = medium-coverage (trusts agent-declared status + GitValidator on commitHash).",
      "lite test 还要求 screenshotPath 指向已存在的截图文件（缺失即 failed），",
      "mid test 要求 commitHash + claimedStatus。",
      "workspacePath 默认 process.cwd()，决定 _cw.db 位置",
      "(${workspacePath}/.xyz-harness/_cw.db)；monorepo/子目录场景需显式传，否则 topic 跨目录找不到。",
      "create 返回 topicId（格式 cw-{date}-{slug}），后续所有 action 必须传此 topicId；",
      "跨 session 接续前从 _cw.db 或 .xyz-harness 取回。",
    ].join("\n"),
    executionMode: "sequential",
    promptGuidelines: [
      "[强制] coding 流程必须经此 tool，禁止绕过状态机。不调 CW = 状态不流转 = 后续 action 全 throw",
      "[强制] 每次调用后按返回的 nextAction 推进，不自决下一阶段。nextAction.action 为空 = 流程结束",
      "[渐进式] dev/test 数组提交，长1=单个/N=批量，CW 累计判定 gatePassed（全 committed/passed 才流转）",
      "[tier 锁定] create 时锁 lite/mid，后续 plan/clarify/detail 的 JSON format 必须 === tier，不匹配 gate 直接拒",
      "[证据] test lite 路径：CW 用 judgeByExpected 机器重算丢 claimedStatus；test mid 路径：信声明 + GitValidator 校验 commitHash 可追溯到已 committed 的 dev commit",
      "[入参] planJson/clarifyJson/detailJson 必须传 object（JSON.parse 后的值），禁止传 JSON 字符串。string 会被 assertFormat 拒（报 not an object）",
    ],
    parameters: CwParamsSchema,
    async execute(
      _toolCallId: string,
      rawParams: CwParams,
      signal: AbortSignal | undefined,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: ActionResult }> {
      if (signal?.aborted) {
        throw new Error("coding-workflow call aborted by signal.");
      }
      // composition root：从 params 推 workspacePath，构造 deps。
      // dbPath 放 workspacePath/.xyz-harness/_cw.db。
      // topicDir 不在 deps——各 action handler loadTopic 后用 topic.topicDir 构造 GateContext
      // （ROOT-01 修复：原 topicDir=workspacePath 导致读盘 gate 全 fail）。
      const workspacePath = rawParams.workspacePath ?? process.cwd();
      const deps: ActionDeps = {
        store: new CwStore(`${workspacePath}/.xyz-harness/_cw.db`),
        git: new GitValidator(workspacePath),
        runner: new GateRunner(workspacePath),
        workspacePath,
      };
      try {
        const result = dispatch(rawParams as CwParams, deps);
        return {
          content: [{ type: "text", text: renderSummary(result) }],
          details: result,
        };
      } finally {
        // 每次 execute 后关连接（#14 单 session 串行假设；CwStore 无模块级状态，session 隔离合规）。
        deps.store.close();
      }
    },
  });
}

// ── 扩展工厂（默认导出） ─────────────────────────────────────

export default function codingWorkflowExtension(pi: ExtensionAPI): void {
  registerCodingWorkflowTool(pi);
}

// ── 渲染（content 文本，TUI 展示用） ─────────────────────────

/**
 * gate fail 时 mustFix 摘要的最大长度。
 *
 * mustFix 完整内容可能很长（多 checker 的拼接 report），TUI 摘要截断到这个长度避免刷屏。
 * 完整报告在 .xyz-harness/{slug}/changes/machine-check-{phase}.md，agent 可去那里看全文。
 */
const MUSTFIX_SUMMARY_MAX_LEN = 800;

/**
 * 渲染 tool execute 返回的 content[0].text（TUI 展示用）。
 *
 * gate fail 时 handler 把 fail report 拼成 mustFix 字符串塞进 ActionResult，
 * 但旧版 renderSummary 只输出 nextAction.guidance（导航文案），agent 在 TUI 看不到
 * 具体哪几项 fail——信息链路断裂。修复：gate fail（mustFix 字段存在）时把它摘要进
 * content 文本，agent 拿到具体 fail 清单才知道改什么。
 *
 * 完整 fail report 落盘在 .xyz-harness/{slug}/changes/machine-check-{phase}.md，
 * 这里截断到 MUSTFIX_SUMMARY_MAX_LEN 防刷屏，agent 需要全文去 changes/ 目录看。
 */
function renderSummary(result: ActionResult): string {
  const head = `[cw] ${result.nextAction.action ?? "(done)"} — status=${result.status}` +
    ` gateTier=${result.gateTier ?? "-"} guidance=${result.nextAction.guidance}`;
  const mustFix = result.mustFix;
  if (typeof mustFix === "string" && mustFix.length > 0) {
    const truncated = mustFix.length > MUSTFIX_SUMMARY_MAX_LEN
      ? `${mustFix.slice(0, MUSTFIX_SUMMARY_MAX_LEN)}…（截断，完整报告见 changes/machine-check-*.md）`
      : mustFix;
    return `${head}\n\nmustFix:\n${truncated}`;
  }
  return head;
}
