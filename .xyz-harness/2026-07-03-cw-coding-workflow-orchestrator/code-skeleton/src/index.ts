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

import { handleCloseout, type CloseoutParams } from "./cw/actions/closeout.js";
import { handleClarify, type ClarifyParams } from "./cw/actions/clarify.js";
import { handleCreate, type CreateParams } from "./cw/actions/create.js";
import { handleDetail, type DetailParams } from "./cw/actions/detail.js";
import { handleDev, type DevParams } from "./cw/actions/dev.js";
import { handlePlan, type PlanParams } from "./cw/actions/plan.js";
import { handleRetrospect, type RetrospectParams } from "./cw/actions/retrospect.js";
import { handleTest, type TestParams } from "./cw/actions/test.js";
import { GateRunner, GitValidator } from "./cw/gates.js";
import { CwStore } from "./cw/store.js";
import type { ActionDeps, ActionResult } from "./cw/types.js";

// ── typebox schema（tool 入参，Pi 运行时校验） ───────────────

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
  // plan/clarify/detail：结构化 JSON（CW 内部已 parse 为对象传入）
  planJson: Type.Optional(Type.Object({})),
  clarifyJson: Type.Optional(Type.Object({})),
  detailJson: Type.Optional(Type.Object({})),
  // dev
  tasks: Type.Optional(Type.Array(Type.Object({
    waveId: Type.String(),
    commitHash: Type.String(),
  }))),
  // test
  cases: Type.Optional(Type.Array(Type.Object({}))),
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
  // 接线：switch action → handleX（每 action 独立 handler）。
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

export function registerCodingWorkflowTool(pi: ExtensionAPI): void {
  // 接线：pi.registerTool，execute 内构造 deps + dispatch。
  pi.registerTool({
    name: "coding-workflow",
    label: "Coding Workflow Orchestrator",
    description:
      "CW 编码流程编排 tool（D-002 上层编排器）。垄断 coding 流程状态流转 + gate 验证。\n" +
      "action: create-topic → plan/clarify → detail → dev → test → retrospect → closeout。\n" +
      "每次返回 nextAction 指导下一步。",
    executionMode: "sequential",
    promptGuidelines: [
      "[强制] coding 流程必须经此 tool，禁止绕过状态机",
      "[渐进式] dev/test 数组提交，长1=单个/N=批量，CW 累计判定 gatePassed",
      "[tier 锁定] create 时锁 lite/mid，后续 format 必须 === tier",
    ],
    parameters: CwParamsSchema,
    async execute(_toolCallId, rawParams, signal) {
      if (signal?.aborted) {
        throw new Error("coding-workflow call aborted by signal.");
      }
      // composition root：从 params 推 workspacePath，构造 deps。
      // （实现期：store 按 topic 的 workspacePath 开 db；此处骨架用占位路径。）
      const workspacePath = (rawParams as { workspacePath?: string }).workspacePath ?? process.cwd();
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
        // 骨架：每次 execute 后关连接（实现期按 session 生命周期管理，#14 单 session 假设）。
        deps.store.close();
      }
    },
  });
}

// ── 扩展工厂（默认导出） ─────────────────────────────────────

export default function codingWorkflowExtension(pi: ExtensionAPI): void {
  // 接线：工厂入口，注册 CW tool（取代 test-orchestrator）。
  registerCodingWorkflowTool(pi);
}

// ── 渲染（content 文本，TUI 展示用） ─────────────────────────

function renderSummary(result: ActionResult): string {
  return `[cw] ${result.nextAction.action ?? "(done)"} — status=${result.status}` +
    ` gateTier=${result.gateTier ?? "-"} guidance=${result.nextAction.guidance}`;
}
