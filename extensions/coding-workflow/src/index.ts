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
import { CwStore } from "./cw/store.js";
import type { ActionDeps, ActionResult } from "./cw/types.js";

// ── typebox schema（tool 入参，Pi 运行时校验） ───────────────

// plan/clarify/detail/cases 是 agent 从文件读的任意 JSON，schema 层只描述「是个值」，
// 真正的结构校验在 plan-parser.ts 内（typebox Value.Check + format 锁定）。
// 用 Type.Unknown() 而非 Type.Object({})：后者是「无属性的空对象」，会拒收任意字段。
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
  // plan/clarify/detail：结构化 JSON（agent 读文件后内联传入）
  planJson: Type.Optional(Type.Unknown()),
  clarifyJson: Type.Optional(Type.Unknown()),
  detailJson: Type.Optional(Type.Unknown()),
  // dev（D-005 数组，长1=单个/N=批量）
  tasks: Type.Optional(Type.Array(Type.Object({
    waveId: Type.String(),
    commitHash: Type.String(),
  }))),
  // test（数组，元素结构按 tier 分化，test.ts 内部校验）
  cases: Type.Optional(Type.Array(Type.Unknown())),
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
  planJson?: unknown;
  clarifyJson?: unknown;
  detailJson?: unknown;
  tasks?: Array<{ waveId: string; commitHash: string }>;
  cases?: unknown[];
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
    description:
      "CW 编码流程编排 tool（D-002 上层编排器）。垄断 coding 流程状态流转 + gate 验证。\n" +
      "action: create → plan/clarify → detail → dev → test → retrospect → closeout。\n" +
      "每次返回 nextAction 指导下一步。tier 在 create 时锁定（lite/mid），后续不可变。",
    executionMode: "sequential",
    promptGuidelines: [
      "[强制] coding 流程必须经此 tool，禁止绕过状态机",
      "[渐进式] dev/test 数组提交，长1=单个/N=批量，CW 累计判定 gatePassed",
      "[tier 锁定] create 时锁 lite/mid，后续 format 必须 === tier",
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
      // dbPath 放 workspacePath/.xyz-harness/_cw.db（topic 工作区约定，与 state-machine.ts 的
      // topicDir 一致；.xyz-harness/ 已是 topic 级产出目录）。
      const workspacePath = rawParams.workspacePath ?? process.cwd();
      const deps: ActionDeps = {
        store: new CwStore(`${workspacePath}/.xyz-harness/_cw.db`),
        git: new GitValidator(workspacePath),
        runner: new GateRunner(workspacePath),
        workspacePath,
        topicDir: workspacePath,
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

function renderSummary(result: ActionResult): string {
  return `[cw] ${result.nextAction.action ?? "(done)"} — status=${result.status}` +
    ` gateTier=${result.gateTier ?? "-"} guidance=${result.nextAction.guidance}`;
}
