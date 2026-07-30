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

// ── W1: postMessage 防御 + parallel() 降级类型安全 ──

describe("buildWorkerScript — W1 postMessage defense & parallel degrade", () => {
  const script = buildWorkerScript("// noop user script");

  describe("_safePost wrapper", () => {
    it("injects _safePost function", () => {
      expect(script).toContain("function _safePost(msg, context)");
    });

    it("_safePost wraps postMessage in try/catch", () => {
      // _safePost 在 module scope（parentPort 解析为 _parentPort），
      // 用宽松正则匹配「try { <something>.postMessage(msg)」避免绑死变量名。
      expect(script).toMatch(/_safePost[\s\S]*?try \{ _parentPort\.postMessage\(msg\)/);
    });

    it("_safePost logs failure with context to workerLogs", () => {
      expect(script).toContain('_pushWorkerLog("error"');
      expect(script).toContain('"[postMessage failed:" + context + "]"');
    });
  });

  describe("agent() uses _safePost", () => {
    it("agent-call postMessage guarded by _safePost", () => {
      expect(script).toContain("_safePost({ type: \"agent-call\"");
      expect(script).toContain('"agent-call"');
    });

    it("agent() throws on postMessage failure", () => {
      expect(script).toContain("postMessage failed for agent-call");
    });
  });

  describe("workflow() uses _safePost", () => {
    it("workflow-call postMessage guarded by _safePost", () => {
      expect(script).toContain("_safePost({ type: \"workflow-call\"");
    });
  });

  describe("return/error use _safePost", () => {
    it("return postMessage uses _safePost", () => {
      expect(script).toContain('_safePost({ type: "return"');
    });

    it("error postMessage uses _safePost", () => {
      expect(script).toContain('_safePost({ type: "error"');
    });
  });

  describe("parallel() degrade returns object", () => {
    it("rejected results become {status:failed,error} objects", () => {
      expect(script).toContain('status: "failed"');
      expect(script).toMatch(/parallel[\s\S]*?status: "failed"/);
    });

    it("non-object fulfilled values wrapped as failed", () => {
      expect(script).toContain("agent returned non-object result");
    });

    it("object fulfilled values pass through unchanged", () => {
      expect(script).toContain("!Array.isArray(v)");
    });
  });

  describe("pipeline() error observability", () => {
    it("single-arg mode logs stage errors before re-throwing", () => {
      expect(script).toContain("[pipeline stage ");
      expect(script).toContain("_pushWorkerLog(\"error\"");
    });

    it("cartesian mode logs stage errors instead of silent swallow", () => {
      expect(script).toContain("[pipeline cartesian stage failed");
    });
  });
});
