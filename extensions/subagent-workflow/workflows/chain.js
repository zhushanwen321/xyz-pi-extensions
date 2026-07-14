// chain.js — 顺序多步处理（通用 subagent 编排）
//
// 模式：analyze → transform → synthesize，每步 agent() 输出作下步输入。
// 适用于需要"先分析、再变换、最后综合"的多阶段任务。
//
// 用法：
//   workflow run chain --args task="把这段需求文档拆成技术任务：..."
//
// ⚠️ lintScript 约束（本脚本已遵守）：
//   - 含 agent() 入口
//   - 禁止 bare IIFE（用 top-level await）
//   - 禁止用 result 作变量名

const meta = {
  name: "chain",
  description: "通用编排：analyze → transform → synthesize 顺序三步链",
  phases: ["analyze", "transform", "synthesize"],
};

// ── 入参（$ARGS）──────────────────────────────────────────────────
const task = $ARGS.task;
if (!task) {
  throw new Error("chain 缺少必需参数 task。用法：workflow run chain --args task=\"<任务描述>\"");
}

log("chain 开始，task=" + task);

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：analyze（分析任务，提取关键点）─────────────────────────
  phase("analyze");
  currentPhase = "analyze";
  const analysis = await agent({
    prompt: "分析以下任务，提取核心洞察和关键点：\n\n" + task,
    schema: {
      type: "object",
      properties: {
        insights: { type: "string", description: "对任务的核心洞察" },
        keyPoints: {
          type: "array",
          items: { type: "string" },
          description: "关键点列表",
        },
      },
      required: ["insights", "keyPoints"],
    },
    description: "chain-analyze",
  });

  // ── 段 2：transform（基于分析产出方案）───────────────────────────
  phase("transform");
  currentPhase = "transform";
  const plan = await agent({
    prompt:
      "基于以下分析结果，产出可执行方案：\n\n洞察：" + (analysis?.insights ?? "(分析无结果)") +
      "\n关键点：" + JSON.stringify(analysis?.keyPoints ?? []),
    schema: {
      type: "object",
      properties: {
        plan: { type: "string", description: "执行方案" },
        actions: {
          type: "array",
          items: { type: "string" },
          description: "具体行动步骤",
        },
      },
      required: ["plan", "actions"],
    },
    description: "chain-transform",
  });

  // ── 段 3：synthesize（综合方案输出最终结论）─────────────────────
  phase("synthesize");
  currentPhase = "synthesize";
  const final = await agent({
    prompt:
      "综合以下方案，输出最终结论和建议：\n\n方案：" + (plan?.plan ?? "(方案无结果)") +
      "\n行动步骤：" + JSON.stringify(plan?.actions ?? []),
    schema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "最终总结" },
        recommendation: { type: "string", description: "核心建议" },
      },
      required: ["summary", "recommendation"],
    },
    description: "chain-synthesize",
  });

  outcome = {
    status: "ok",
    phases_run: ["analyze", "transform", "synthesize"],
    final: { summary: (final?.summary ?? "(综合无结果)"), recommendation: (final?.recommendation ?? "(综合无结果)") },
    message: "chain 完成：analyze → transform → synthesize 全绿",
  };
} catch (err) {
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "chain 在 " + currentPhase + " 段失败",
  };
}

return outcome;
