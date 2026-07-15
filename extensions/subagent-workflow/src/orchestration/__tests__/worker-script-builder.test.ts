/**
 * buildWorkerScript — workflow() 全局函数注入测试。
 *
 * 验证生成的 worker 源码字符串包含 workflow 嵌套调用所需的全部契约：
 * - workflow() 全局函数声明
 * - workflow-call 消息（Worker → Main）
 * - workflow-result 消息处理（Main → Worker）
 * - execute() context 包含 workflow
 * - name 参数校验
 */
import { describe, expect, it } from "vitest";

import { buildWorkerScript } from "../worker-script-builder.ts";

describe("buildWorkerScript — workflow() global injection", () => {
  const script = buildWorkerScript("// noop user script");

  it("injects workflow() global function", () => {
    expect(script).toContain("async function workflow");
  });

  it('workflow() sends workflow-call message', () => {
    expect(script).toContain('type: "workflow-call"');
  });

  it('handles workflow-result message', () => {
    // worker 是 workflow-result 的接收方，用条件分支处理（非对象字面量）
    expect(script).toContain('msg.type === "workflow-result"');
  });

  it("execute() context includes workflow", () => {
    expect(script).toContain(
      "module.exports.execute({ agent, parallel, pipeline, phase, log, workflow, $ARGS, $WORKSPACE, $BUDGET })",
    );
  });

  it("workflow() validates name argument", () => {
    expect(script).toContain(
      "workflow() requires a workflow name string as first argument",
    );
  });
});

// ── H3: agent() task/agent 分支 skill 字段传递 ──

describe("buildWorkerScript — agent() skill field in task/agent branch", () => {
  const script = buildWorkerScript("// noop user script");

  it("task/agent branch includes skill in opts whitelist", () => {
    // H3: agent({task, agent, skill}) 的 skill 在 task/agent 分支被丢弃。
    // 验证生成的 worker 源码中，task/agent 分支的 opts 构造含 skill 字段。
    // 找到 task/agent 分支的 opts 构造代码（含 firstArg.task || firstArg.agent）
    const taskAgentBranch = script.match(/firstArg\.task \|\| firstArg\.agent[\s\S]*?\};/);
    expect(taskAgentBranch).toBeTruthy();
    expect(taskAgentBranch![0]).toContain("skill: firstArg.skill");
  });
});
