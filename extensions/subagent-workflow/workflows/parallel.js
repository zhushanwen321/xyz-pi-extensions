// parallel.js — 并行多视角分析（通用 subagent 编排）
//
// 模式：N 个 agent 从不同角度并行分析同一目标 → 汇总聚合。
// 适用于需要多维度评估（安全/性能/可维护性等）的场景。
//
// 用法：
//   workflow run parallel --args target="src/auth/login.ts"
//   workflow run parallel --args target="..." --args 'perspectives=["security","readability"]'
//
// ⚠️ 分层配额规则（来源：ADR-030 决策 3）：
//   - 全局并发上限 maxConcurrent = 6
//   - parallel() 内的 agent() 调用共享配额池，超出自动排队（不报错）
//   - 本脚本默认 3 视角并行，配额充足
//
// ⚠️ lintScript 约束（本脚本已遵守）：含 parallel() 入口，禁止 bare IIFE

const meta = {
  name: "parallel",
  description: "通用编排：多视角并行分析同一目标，再聚合汇总",
  phases: ["parallel-analyze", "aggregate"],
};

// ── 入参（$ARGS）──────────────────────────────────────────────────
const target = $ARGS.target;
if (!target) {
  throw new Error("parallel 缺少必需参数 target。用法：workflow run parallel --args target=\"<分析目标>\"");
}
const perspectives = Array.isArray($ARGS.perspectives) && $ARGS.perspectives.length > 0
  ? $ARGS.perspectives
  : ["security", "performance", "maintainability"];

log("parallel 开始，target=" + target + " perspectives=" + JSON.stringify(perspectives));

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：parallel-analyze（多视角并行分析）──────────────────────
  phase("parallel-analyze");
  currentPhase = "parallel-analyze";

  // parallel() 接受 Promise 数组；agent() 返回 Promise。allSettled 语义。
  const perPerspectiveRaw = await parallel(
    perspectives.map((p) =>
      agent({
        prompt:
          "从「" + p + "」角度分析以下目标，给出评分和发现的问题：\n\n" + target,
        schema: {
          type: "object",
          properties: {
            perspective: { type: "string", description: "视角名称" },
            score: { type: "number", description: "0-10 评分" },
            findings: {
              type: "array",
              items: { type: "string" },
              description: "发现的问题",
            },
          },
          required: ["perspective", "score", "findings"],
        },
        description: "parallel-" + p,
      })
    ),
  );

  // 收集结果，标记成功/失败
  const perPerspective = [];
  let failedCount = 0;
  for (let i = 0; i < perPerspectiveRaw.length; i++) {
    const r = perPerspectiveRaw[i];
    if (!r || r.error) {
      perPerspective.push({
        perspective: perspectives[i],
        status: "failed",
        error: r ? r.error : "agent 无返回",
      });
      failedCount++;
    } else {
      perPerspective.push({ perspective: perspectives[i], status: "ok", ...r });
    }
  }
  if (failedCount === perspectives.length) {
    throw new Error("全部视角分析失败（" + failedCount + "/" + perspectives.length + "）");
  }
  log("parallel-analyze 完成：ok=" + (perspectives.length - failedCount) + " failed=" + failedCount);

  // ── 段 2：aggregate（汇总多视角结果）────────────────────────────
  phase("aggregate");
  currentPhase = "aggregate";
  const aggregate = await agent({
    prompt:
      "以下是多视角分析结果，请综合出总体评分、top 问题和共识：\n\n" +
      JSON.stringify(perPerspective, null, 2),
    schema: {
      type: "object",
      properties: {
        overallScore: { type: "number", description: "综合评分 0-10" },
        topIssues: {
          type: "array",
          items: { type: "string" },
          description: "最关键的问题（按严重度排序）",
        },
        consensus: { type: "string", description: "多视角共识总结" },
      },
      required: ["overallScore", "topIssues", "consensus"],
    },
    description: "parallel-aggregate",
  });

  outcome = {
    status: failedCount > 0 ? "partial" : "ok",
    phases_run: ["parallel-analyze", "aggregate"],
    perspectives_analyzed: perspectives.length,
    per_perspective: perPerspective,
    aggregate: {
      overallScore: aggregate.overallScore,
      topIssues: aggregate.topIssues,
      consensus: aggregate.consensus,
    },
    message: "parallel 完成：" + perspectives.length + " 视角（失败 " + failedCount + "）→ 聚合",
  };
} catch (err) {
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "parallel 在 " + currentPhase + " 段失败",
  };
}

return outcome;
