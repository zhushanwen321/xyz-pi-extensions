---
verdict: draft
priority: P1
depends-on: [P0]
blocks: [P2]
estimated-days: 2-3
---

# P1: Phase 1/2 Review-Gate Workflow（最小可用验证）

## Goal

将 Phase 1/2 的 Review-Gate 从 `runSingleAgent` 迁移到 Workflow Extension。Phase 1/2 逻辑最简单（单 agent 循环审查），适合作为 `pi.__workflowRun` 通道的集成验证。同时创建 3 个 agent 文件和 2 个 workflow 脚本。

## 前置条件

P0 完成：
- `pi.__workflowRun` 可用且能正确等待 workflow 完成
- Gate Pipeline 抽象已就位（`ReviewGate` 类已创建）
- `executeGateTool` 按 gates 数组顺序执行

## 核心设计

### ReviewGate 如何调用 workflow？

P0 创建的 `ReviewGate` 类，P1 阶段替换内部实现：

```typescript
// review-gate.ts — P1 替换
export class ReviewGate implements Gate {
  async run(ctx: GateContext): Promise<GateResult> {
    // 检查 pi.__workflowRun 是否可用
    const workflowRun = this.getWorkflowRun(ctx.pi);
    if (!workflowRun) {
      // 降级到 runSingleAgent（workflow extension 未安装）
      return this.runFallback(ctx);
    }

    const workflowName = `phase${ctx.phase}-review-gate`;
    const args = {
      topicDir: ctx.topicDir,
      phase: ctx.phase,
      maxRounds: 3,
    };

    const result = await workflowRun(workflowName, args, ctx.signal);
    if (result.status !== "completed" || result.error) {
      return {
        passed: false,
        fixGuidance: `Review-Gate workflow failed: ${result.error ?? "unknown error"}`,
        details: { status: result.status },
      };
    }

    // 解析 scriptResult
    const data = result.scriptResult as ReviewGateOutput;
    if (!data.passed) {
      return {
        passed: false,
        fixGuidance: `Review-Gate FAILED after ${data.rounds} rounds (last must_fix=${data.lastMustFix}).\n\nFix the issues, then call coding-workflow-gate(phase=${ctx.phase}) again.`,
        details: data,
      };
    }

    // 写状态文件
    await this.persistState(ctx.topicDir, ctx.phase, data);
    return { passed: true, details: data };
  }
}
```

### 降级策略

当 `pi.__workflowRun` 不可用时（workflow extension 未安装），ReviewGate 降级到 P0 的 `runSingleAgent` 逻辑。这确保 coding-workflow 在没有 workflow extension 的环境也能工作。

### Agent 文件发现

workflow 脚本中的 `agent({ agent: "spec-requirements-reviewer" })` 需要通过 `AgentRegistry` 解析到对应的 `.md` 文件。

**验证要点**：coding-workflow 的 `agents/` 目录下的 `.md` 文件是否在 `AgentRegistry` 的扫描路径中。

如果不在扫描路径中，需要：
1. 方案 A：将 agent 文件放到 `.pi/agents/` 目录（项目级 agent 发现路径）
2. 方案 B：在 workflow 脚本中将 SKILL.md 内容内联到 prompt（不依赖 agent 发现）
3. 方案 C：修改 `AgentRegistry` 增加扩展目录扫描

**推荐**：先验证方案 A 是否可行（`.pi/agents/` 是否在扫描路径中），不行则用方案 B。

## File Structure

| 操作 | 文件 | 行数估计 | 说明 |
|------|------|---------|------|
| **create** | `extensions/coding-workflow/agents/spec-requirements-reviewer.md` | ~80 | Phase 1 审查 agent |
| **create** | `extensions/coding-workflow/agents/plan-requirements-reviewer.md` | ~80 | Phase 2 L1/L2 共用 |
| **create** | `extensions/coding-workflow/agents/plan-bl-requirements-reviewer.md` | ~60 | Phase 2 L2 专用 |
| **create** | `.pi/workflows/phase1-review-gate.js` | ~60 | Phase 1 Review-Gate workflow |
| **create** | `.pi/workflows/phase2-review-gate.js` | ~80 | Phase 2 Review-Gate workflow（L1/L2） |
| **modify** | `extensions/coding-workflow/lib/gates/review-gate.ts` | ~120 | 替换为 `pi.__workflowRun` + 降级逻辑 |

## Task List

### Task 1.1: 创建 `spec-requirements-reviewer.md`

**文件**: `extensions/coding-workflow/agents/spec-requirements-reviewer.md`

Agent 职责：
- 审查 `spec.md` 的完整性、一致性、清晰度
- 检查项：Problem Statement / Goals / Non-Goals / Use Cases / Constraints / Acceptance Criteria / Architecture Decisions
- 发现问题后**直接修复 spec.md**
- 输出 review 报告到 `changes/reviews/phase-1/spec_review_v{round}.md`

frontmatter 格式：
```markdown
---
name: spec-requirements-reviewer
description: "Reviews spec.md for completeness, consistency, and clarity. Fixes issues directly."
---
```

YAML 输出格式：
```yaml
verdict: pass|fail
must_fix: <number>
issues:
  - id: SRR-001
    severity: must_fix|should_fix|nice_to_have
    category: completeness|consistency|clarity|feasibility
    description: "..."
    file: spec.md
    location: "Section: Goals"
```

**注意**：
- agent 必须能读取 `$ARGS.topicDir` 指定的目录中的 spec.md
- `$ARGS` 在 workflow 脚本中可用，通过 `agent({ prompt: "... topicDir ..." })` 传递
- 不依赖 `agent({ agent: "name" })` 发现——优先将指令写在 prompt 中，agent name 作为 system prompt 补充

### Task 1.2: 创建 `plan-requirements-reviewer.md`

**文件**: `extensions/coding-workflow/agents/plan-requirements-reviewer.md`

Agent 职责：
- 审查 `plan.md` 的可行性、交付物完整性、Execution Groups 合理性
- 检查项：File Structure 与 spec 对应关系、Task 粒度、Execution Group 分组、依赖关系图
- 输出 review 报告到 `changes/reviews/phase-2/plan_review_v{round}.md`

frontmatter 格式同上，`name: plan-requirements-reviewer`。

### Task 1.3: 创建 `plan-bl-requirements-reviewer.md`

**文件**: `extensions/coding-workflow/agents/plan-bl-requirements-reviewer.md`

Agent 职责：
- 审查业务逻辑覆盖度（spec use-cases → plan tasks 的映射验证）
- 仅在 L2 复杂度时启用
- 输出到 `changes/reviews/phase-2/bl_review_v{round}.md`

frontmatter 格式同上，`name: plan-bl-requirements-reviewer`。

### Task 1.4: 创建 `phase1-review-gate.js` workflow 脚本

**文件**: `.pi/workflows/phase1-review-gate.js`

```javascript
const meta = {
  name: "phase1-review-gate",
  description: "Phase 1 Spec Review-Gate: review and fix spec.md in a loop",
};

(async () => {
  const { topicDir, maxRounds = 3 } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-1`;
  let lastMustFix = -1;
  let stagnationCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    const reviewPath = `${reviewsDir}/spec_review_v${round}.md`;

    const result = await agent({
      prompt: [
        `Review and fix spec.md for Phase 1.`,
        `Topic directory: ${topicDir}`,
        `Round: ${round}`,
        `Write review to: ${reviewPath}`,
        ``,
        `Instructions:`,
        `1. Read ${topicDir}/spec.md`,
        `2. Evaluate completeness, consistency, clarity`,
        `3. Fix any issues directly in spec.md`,
        `4. Write review report to ${reviewPath}`,
        `5. YAML frontmatter: verdict (pass/fail), must_fix (count)`,
        ``,
        `If all issues are fixed, set verdict=pass and must_fix=0.`,
      ].join("\n"),
      description: `phase1-spec-review-r${round}`,
    });

    // 解析 review 文件获取 must_fix
    // 注意：agent() 返回的是文本，需要从 review 文件解析
    // workflow 脚本中没有 fs 模块，需要靠 agent 自己写文件并报告结果
    // 替代方案：让 agent 用 schema 返回结构化结果
    const mustFix = parseMustFixFromReviewPath(reviewPath);

    if (mustFix <= 0) {
      return { passed: true, rounds: round, lastMustFix: 0, reviewPath };
    }

    // Stagnation check
    if (lastMustFix >= 0 && mustFix >= lastMustFix) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        return { passed: false, rounds: round, lastMustFix: mustFix, stagnation: true };
      }
    } else {
      stagnationCount = 0;
    }
    lastMustFix = mustFix;
  }

  return { passed: false, rounds: maxRounds, lastMustFix, maxRounds: true };
})();
```

**关键限制**：workflow 脚本运行在 Worker thread 中，**没有 fs 模块**。无法直接读取 review 文件解析 must_fix。

**解决方案**：让 agent 返回结构化 JSON（通过 `schema` 参数）：

```javascript
const result = await agent({
  prompt: `...review instructions... After reviewing, report your findings as JSON.`,
  schema: {
    type: "object",
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      must_fix: { type: "number" },
      summary: { type: "string" },
    },
    required: ["verdict", "must_fix", "summary"],
  },
  description: `phase1-spec-review-r${round}`,
});
// result 此时是 parsedOutput（JSON 对象）或文本
```

**注意**：`schema` 参数会让 `agent()` 自动将 schema 指令追加到 prompt 中，并尝试 `JSON.parse` 输出。成功时 `parsedOutput` 可用。在 workflow 脚本中 `agent()` 返回的是 `parsedOutput ?? output`（字符串）。

### Task 1.5: 创建 `phase2-review-gate.js` workflow 脚本

**文件**: `.pi/workflows/phase2-review-gate.js`

```javascript
const meta = {
  name: "phase2-review-gate",
  description: "Phase 2 Plan Review-Gate: L1 single-agent or L2 dual-agent serial",
};

(async () => {
  const { topicDir, complexity = "L1", maxRounds = 3 } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-2`;
  let lastMustFix = -1;
  let stagnationCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    // L1: 单 agent
    // L2: 串行双 agent (plan-requirements + plan-bl-requirements)
    if (complexity === "L2") {
      // Agent 1: plan requirements
      const reqResult = await agent({
        prompt: `Review plan requirements... Topic: ${topicDir}, Round: ${round}`,
        schema: { /* verdict, must_fix, summary */ },
        description: `phase2-plan-review-r${round}`,
      });
      // Agent 2: BL requirements (only if req passed or has few issues)
      const blResult = await agent({
        prompt: `Review business logic coverage... Topic: ${topicDir}, Round: ${round}`,
        schema: { /* verdict, must_fix, summary */ },
        description: `phase2-bl-review-r${round}`,
      });
      // 合并 must_fix
      var totalMustFix = parseResult(reqResult).mustFix + parseResult(blResult).mustFix;
    } else {
      // L1: 单 agent
      const result = await agent({
        prompt: `Review plan requirements... Topic: ${topicDir}, Round: ${round}`,
        schema: { /* verdict, must_fix, summary */ },
        description: `phase2-plan-review-r${round}`,
      });
      var totalMustFix = parseResult(result).mustFix;
    }

    if (totalMustFix <= 0) {
      return { passed: true, rounds: round, lastMustFix: 0 };
    }

    // Stagnation check
    if (lastMustFix >= 0 && totalMustFix >= lastMustFix) {
      stagnationCount++;
      if (stagnationCount >= 2) {
        return { passed: false, rounds: round, lastMustFix: totalMustFix, stagnation: true };
      }
    } else {
      stagnationCount = 0;
    }
    lastMustFix = totalMustFix;
  }

  return { passed: false, rounds: maxRounds, lastMustFix, maxRounds: true };
})();
```

**注意**：
- `complexity` 参数需要从 plan.md 中解析。Phase 2 的 plan.md 的 YAML frontmatter 中有 `complexity: L1|L2` 字段
- 如果无法解析，默认 L1
- L2 模式下两个 agent 串行执行（先 requirements 再 BL），不用 `parallel()`——因为 BL 审查可能依赖 requirements 审查的发现

### Task 1.6: ReviewGate 替换实现

**文件**: `extensions/coding-workflow/lib/gates/review-gate.ts`

替换 P0 桩为正式实现：

1. 检测 `pi.__workflowRun` 是否存在
2. 存在 → 调用 `pi.__workflowRun("phase${phase}-review-gate", args, signal)`
3. 不存在 → 降级到 `runReviewGateLoop`（P0 桩逻辑）
4. 解析 scriptResult → 写 `.review-gate-p{N}.json` → 返回 GateResult

**降级逻辑**：

```typescript
private getWorkflowRun(pi: ExtensionAPI): WorkflowRunFn | undefined {
  const api = pi as unknown as Record<string, unknown>;
  if (typeof api.__workflowRun === "function") {
    return api.__workflowRun as WorkflowRunFn;
  }
  return undefined;
}
```

### Task 1.7: Lint workflow 脚本

创建完两个 workflow 脚本后，确认能通过 `script-lint`：

```bash
# 在 Pi 中执行
pi workflow-lint phase1-review-gate
pi workflow-lint phase2-review-gate
```

注意 lint 规则：
- 禁止 `result.output` / `result.parsedOutput` / `result.content`（agent() 返回解包后的值）
- 禁止 `outputSchema`（应该是 `schema`）
- 禁止 `readFileSync`/`writeFileSync`（worker thread 中不可用）

## Dependency Graph

```
Task 1.1 (spec-reviewer) ──┐
Task 1.2 (plan-reviewer) ──┤──→ Task 1.4 (phase1 workflow) ──→ Task 1.6 (ReviewGate 替换)
Task 1.3 (bl-reviewer) ────┤──→ Task 1.5 (phase2 workflow) ──→ Task 1.6
                            └──→ Task 1.7 (lint)
```

可并行：
- Task 1.1/1.2/1.3（agent 文件）之间无依赖
- Task 1.4 和 1.5 可以并行开发

## Acceptance Criteria

1. Phase 1 Review-Gate 通过 `pi.__workflowRun("phase1-review-gate")` 执行，不再用 `runSingleAgent`
2. Phase 2 L1/L2 分支正确路由（根据 plan.md 的 complexity 字段）
3. `.review-gate-p1.json` / `.review-gate-p2.json` 在 workflow 完成后正确写入
4. Agent 文件被正确发现（或 prompt 内联方案可行）
5. Stagnation 检查（2 轮 must_fix 不降）和 max rounds（3 轮）退出逻辑正确
6. 降级逻辑正确：workflow extension 未安装时回退到 `runSingleAgent`
7. Workflow 脚本通过 `script-lint`

## 验证命令

```bash
# 类型检查
pnpm --filter @zhushanwen/pi-coding-workflow typecheck

# Lint
pnpm --filter @zhushanwen/pi-coding-workflow lint

# 手动验证
/coding-workflow test spec review feature
# Phase 1 完成后调用 coding-workflow-gate(phase=1)
# 应看到 workflow 启动、agent 审查、循环/退出
```

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Agent 文件不在 AgentRegistry 扫描路径中 | `agent({ agent: "name" })` 无法解析 | 方案 B：将 agent 指令内联到 prompt；或方案 A：放到 `.pi/agents/` |
| Worker thread 中无 fs，无法解析 review 文件 | 无法获取 must_fix 数值 | 用 `schema` 参数让 agent 返回结构化 JSON |
| `schema` 参数 JSON.parse 失败 | `parsedOutput` 为 undefined | 在脚本中做 fallback：尝试 JSON.parse，失败时从文本解析 |
| workflow 超时（agent 审查耗时） | runAndWait 10 分钟不够 | 复杂 spec 的审查可能需要较长时间，适当放宽到 15 分钟 |
| Phase 2 complexity 解析失败 | 默认 L1 但实际应该是 L2 | 先尝试读取 plan.md frontmatter，失败时从 workflow args 显式传入 |
