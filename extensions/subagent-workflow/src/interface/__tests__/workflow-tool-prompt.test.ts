// U1: workflow tool 提示词包含内置 workflow 清单 + 交叉引用。
//
// agent（LLM）决策时唯一能看到的 tool 元信息就是 description + promptGuidelines。
// 若这些文本里不提及内置 workflow（chain/parallel/scatter-gather/map-reduce），
// LLM 无法知道有现成的编排工具可用，会倾向自己 generate 脚本或瞎猜 name。
//
// 本测试用源码断言（读 .ts 文件文本）验证提示词内容，避免 import 重 mock 链
// （tool-workflow.ts 依赖 pi-ai/typebox/pi-tui/lifecycle 等值导入）。

import { readFileSync } from "node:fs";
import { dirname,join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_WORKFLOW_SRC = readFileSync(
  join(__dirname, "../tool-workflow.ts"),
  "utf-8",
);
const TOOL_WORKFLOW_SCRIPT_SRC = readFileSync(
  join(__dirname, "../tool-workflow-script.ts"),
  "utf-8",
);

describe("U1: workflow tool prompt mentions built-in workflows", () => {
  it("tool-workflow.ts description 或 promptGuidelines 含 4 个内置 workflow 名称", () => {
    // 4 个内置通用编排 workflow 必须在提示词里出现，LLM 才能发现并使用。
    expect(TOOL_WORKFLOW_SRC).toContain("chain");
    expect(TOOL_WORKFLOW_SRC).toContain("parallel");
    expect(TOOL_WORKFLOW_SRC).toContain("scatter-gather");
    expect(TOOL_WORKFLOW_SRC).toContain("map-reduce");
  });

  it("tool-workflow.ts promptGuidelines 含 workflow-script list 交叉引用", () => {
    // LLM 需要知道"先 list 再 run"的发现路径——两个 tool 之间必须有交叉引用。
    // 文本可能跨字符串拼接行，分别断言两个关键词都存在。
    expect(TOOL_WORKFLOW_SRC).toContain("workflow-script");
    expect(TOOL_WORKFLOW_SRC).toMatch(/action.*list/i);
  });

  it("tool-workflow.ts promptGuidelines 含 run action 的正例", () => {
    // 给出 workflow run <name> 的调用示例，LLM 才知道参数格式。
    expect(TOOL_WORKFLOW_SRC).toMatch(/workflow run .+--args/i);
  });

  it("promptGuidelines 含 JSON 调用正例（run/status/lifecycle/retry-node）", () => {
    // 弱模型信任 schema 结构信号 > 文本信号，容易把 args 子字段平铺到顶层。
    // promptGuidelines 必须有完整 JSON 调用正例，让模型能直接照抄 {"action":"run",...} 嵌套结构。
    expect(TOOL_WORKFLOW_SRC).toContain('{"action":"run"');
    expect(TOOL_WORKFLOW_SRC).toContain("Call shapes (JSON)");
  });

  it("promptGuidelines 含参数结构反例（args 平铺到顶层）", () => {
    // 显式说明 args 子字段不能平铺到顶层，必须嵌在 args 里。
    expect(TOOL_WORKFLOW_SRC).toContain("args");
    expect(TOOL_WORKFLOW_SRC).toContain("Anti-patterns");
    expect(TOOL_WORKFLOW_SRC).toContain("top level");
  });

  it("runtime handler 错误文案含 Correct 纠正正例 + 平铺检测", () => {
    // 读源码文本断言 actionRun/必填校验的错误文案含 Correct 正例，
    // 让弱模型撞错后第二次能直接照抄正确形态。KNOWN_ARG_KEYS 证明平铺检测存在。
    expect(TOOL_WORKFLOW_SRC).toContain("Correct:");
    expect(TOOL_WORKFLOW_SRC).toContain("KNOWN_ARG_KEYS");
  });

  it("tool-workflow-script.ts list action 的 promptGuidelines 含 workflow run 交叉引用", () => {
    // 反向交叉引用：list 的指引里要提到用 workflow tool 的 run action 启动脚本。
    expect(TOOL_WORKFLOW_SCRIPT_SRC).toMatch(/workflow.*tool.*run|run.*workflow.*tool/i);
  });
});
