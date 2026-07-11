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
