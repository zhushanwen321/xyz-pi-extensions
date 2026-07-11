// parallel.example.js — 并行编排模板（UC-2）
//
// 模式：parallel([workflow("analyze-a"), workflow("analyze-b"), workflow("analyze-c")])
// 多个 workflow 并行执行，Promise.allSettled 语义（部分失败不 reject，在 outcome 标 failed）。
//
// 用法：复制本文件到 .pi/workflows/ 或 ~/.pi/agent/workflows/，改 workflow 名后：
//   workflow run parallel --args target=src/main.ts
//
// ⚠️ 分层配额规则（来源：T2 system-architecture §并发池分层配额，ADR-030 并发上限来源）：
//   - 全局并发上限 maxConcurrent = 6（ConcurrencyPool 默认值，T2 实现）
//   - 嵌套 workflow 时按 depth 分层：depth=N 时该层可用配额 = max(1, 6 - N)
//     例：顶层 workflow（depth=0）可用 6 槽；其内再 fork workflow（depth=1）可用 5 槽；
//     depth=5 时保底 1 槽（max(1, 6-5)=1），防饿死。
//   - parallel() 内的 workflow() 调用共享父 workflow 的配额池，超出自动排队（不报错）。
//   - 本模板 parallel 3 个 workflow：顶层配额 6 足够，无需排队。
//
// ⚠️ lintScript 约束（本模板已遵守）：
//   - 含 parallel() 入口（兼展示 workflow() 嵌套）
//   - 禁止 bare IIFE / 禁止变量名 result

const meta = {
  name: "parallel",
  description: "并行编排模板：parallel([workflow A, B, C])，allSettled 语义，分层配额注释",
  phases: ["parallel-analyze"],
};

// ── 入参（$ARGS）──────────────────────────────────────────────────
const target = $ARGS.target;
const tasks = $ARGS.tasks || ["analyze-a", "analyze-b", "analyze-c"]; // 默认 3 路并行
if (!target) {
  throw new Error("parallel 缺少必需参数 target。用法：workflow run parallel --args target=src/main.ts");
}

log("parallel 开始，target=" + target + " tasks=" + JSON.stringify(tasks));

let outcome;

try {
  phase("parallel-analyze");

  // parallel() 接受 Promise 数组；workflow() 返回 Promise<AgentResult>。
  // allSettled 语义：单个 workflow 失败（返回 error 字段）不会让 parallel reject，
  // 全部完成后统一收集，在 outcome 里按 per-task 标 ok/failed。
  const rawResults = await parallel(
    tasks.map((taskName) => workflow(taskName, { target, task: taskName })),
  );

  // 逐个检查 error 字段（workflow 失败入 error 字段，不 throw）
  const perTask = [];
  let hasFailed = false;
  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i];
    if (!r || r.error) {
      perTask.push({ task: tasks[i], status: "failed", error: r ? r.error : "workflow 无返回" });
      hasFailed = true;
    } else {
      perTask.push({ task: tasks[i], status: "ok", content: r.content });
    }
  }

  outcome = {
    status: hasFailed ? "partial" : "ok",
    phase: "parallel-analyze",
    tasks: perTask,
    ok_count: perTask.filter((t) => t.status === "ok").length,
    failed_count: perTask.filter((t) => t.status === "failed").length,
    message: hasFailed
      ? "parallel 完成（部分失败）：ok=" + perTask.filter((t) => t.status === "ok").length +
        " failed=" + perTask.filter((t) => t.status === "failed").length
      : "parallel 全绿：全部 " + perTask.length + " 个 workflow 成功",
  };
} catch (err) {
  // parallel 整体 reject 罕见（通常是引擎级故障），仍兜底返回 error 对象不 crash
  outcome = {
    status: "error",
    phase: "parallel-analyze",
    error: err && err.message ? err.message : String(err),
    message: "parallel 执行抛异常",
  };
}

return outcome;
