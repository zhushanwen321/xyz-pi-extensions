// chain.example.js — 顺序编排模板（UC-1）
//
// 模式：workflow("step-a") → workflow("step-b") → workflow("step-c") → agent(verify)
// 每步输出作下步输入。展示 workflow() 顺序嵌套调用 + try-catch 错误处理。
//
// 用法：复制本文件到 .pi/workflows/ 或 ~/.pi/agent/workflows/，改 workflow 名后：
//   workflow run chain --args inputPath=/path/to/input.json
//
// ⚠️ lintScript 约束（本模板已遵守）：
//   - 必须含 agent()/parallel()/pipeline() 入口之一（本模板末端 agent verify 兼满足 + 真实模式）
//   - 禁止 bare IIFE（用 top-level await）
//   - 禁止用 result 作变量名（lintScript 对 result 变量的 .output / .parsedOutput / .content 访问报 error）

const meta = {
  name: "chain",
  description: "顺序编排模板：workflow A→B→C，每步输出作下步输入，末端 agent 校验",
  phases: ["extract", "transform", "load", "verify"],
};

const fs = require("fs");

// ── 入参（$ARGS）──────────────────────────────────────────────────
const inputPath = $ARGS.inputPath;
if (!inputPath) {
  // 缺参直接 throw（在 try 外，不会被 catch 吞掉，workflow 引擎报清晰错误）
  throw new Error("chain 缺少必需参数 inputPath。用法：workflow run chain --args inputPath=/path/to/input.json");
}
if (!fs.existsSync(inputPath)) {
  throw new Error("inputPath 不存在: " + inputPath);
}

log("chain 开始，inputPath=" + inputPath);

let currentPhase = "init";
let outcome;

try {
  // ── 段 1：extract（workflow 嵌套调用）─────────────────────────────
  phase("extract");
  currentPhase = "extract";
  // workflow() 返回 AgentResult { content, parsedOutput?, usage?, error? }
  // 调用名为 "extract" 的子 workflow，传入 inputPath
  const a = await workflow("extract", { source: inputPath });
  if (a.error) throw new Error("extract 失败: " + a.error);

  // ── 段 2：transform（a.content 作下步输入）────────────────────────
  phase("transform");
  currentPhase = "transform";
  const b = await workflow("transform", { raw: a.content });
  if (b.error) throw new Error("transform 失败: " + b.error);

  // ── 段 3：load（b.content 作下步输入）──────────────────────────────
  phase("load");
  currentPhase = "load";
  const c = await workflow("load", { normalized: b.content });
  if (c.error) throw new Error("load 失败: " + c.error);

  // ── 段 4：verify（agent 校验，兼满足 lintScript entry-point）──────
  phase("verify");
  currentPhase = "verify";
  const verify = await agent({
    prompt: "校验以下 chain 输出是否完整、无遗漏关键字段。输出 valid + summary。\n\n" + c.content,
    schema: {
      type: "object",
      properties: {
        valid: { type: "boolean", description: "chain 输出是否通过校验" },
        summary: { type: "string", description: "校验摘要" },
      },
      required: ["valid", "summary"],
    },
    description: "chain-verify",
  });
  if (!verify.valid) throw new Error("chain verify 失败: " + verify.summary);

  outcome = {
    status: "ok",
    phase: currentPhase,
    final: c.content,
    verify: verify.summary,
    message: "chain 完成：extract → transform → load → verify 全绿",
  };
} catch (err) {
  // 错误处理：返回 error 对象，不 crash（workflow 引擎据 status 决策，非 throw 中断）
  outcome = {
    status: "error",
    phase: currentPhase,
    error: err && err.message ? err.message : String(err),
    message: "chain 在 " + currentPhase + " 段失败",
  };
}

return outcome;
