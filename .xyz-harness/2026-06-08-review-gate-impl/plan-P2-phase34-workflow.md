---
verdict: draft
priority: P2
depends-on: [P1]
blocks: [P3]
estimated-days: 5-7
---

# P2: Phase 3 Review-Gate + Phase 4 Test-Fix Loop（完整覆盖）

## Goal

Phase 3 三阶段 Review-Gate + Phase 4 Test-Fix Loop 全部迁移到 Workflow Extension。这是 spec 中最复杂的两个 phase——Phase 3 有三阶段嵌套循环（外层 3 次重提交 × 内层 3 轮 review-fix），Phase 4 有双 workflow 串行（core → noncore）× 10 轮 test-fix 循环。

## 前置条件

P1 完成：
- `pi.__workflowRun` 通道已验证可用
- Phase 1/2 Review-Gate workflow 模式已确立
- `ReviewGate` 类的 workflow 集成模式已验证
- Agent 文件发现方案已确定（prompt 内联 或 `.pi/agents/`）

## 核心设计

### Phase 3 三阶段架构

```
外层循环（最多 3 次重提交）
  ├── 阶段一：spec-plan-conformance-reviewer
  │   ├── PASS → 进入阶段一.五
  │   └── FAIL → 返回 { passed: false, stage: 1 } → 打回主 agent 重新编码
  │
  ├── 阶段一.五：simulated-data-generator
  │   └── 生成 JSON fixture → 进入阶段二
  │
  └── 阶段二（内层循环，最多 3 轮）
      ├── 并行 5 reviewer:
      │   ├── standards-reviewer（SKILL 内联）
      │   ├── taste-reviewer（SKILL 内联）
      │   ├── robustness-reviewer（SKILL 内联）
      │   ├── fallow-reviewer（新建 agent）
      │   └── integration-reviewer（SKILL 内联）
      │
      ├── review-sync-fix-worker：汇总 must_fix → 判断退出
      │   ├── must_fix = 0 → 返回 { passed: true }
      │   └── must_fix > 0 → 按文件分组修复计划
      │
      ├── file-fix-subagent（每文件一个，串行）
      │   └── 修复同一文件的所有 must_fix → git commit
      │
      └── stagnation check（2 轮不降 → FAIL）
```

### Phase 3 阶段二的 reviewer 来源

| Reviewer | 来源 | 实现方式 |
|----------|------|---------|
| standards | 现有 `xyz-harness-standards-reviewer` SKILL | prompt 内联 SKILL 内容 |
| taste | 现有 `xyz-harness-taste-check` SKILL 或 `review-taste.md` agent | prompt 内联 |
| robustness | 现有 `xyz-harness-robustness-reviewer` SKILL | prompt 内联 |
| fallow | 新建 `fallow-reviewer.md` agent | `agent({ agent: "fallow-reviewer" })` |
| integration | 现有 `xyz-harness-integration-reviewer` SKILL | prompt 内联 |

**注意**：`parallel()` 最多支持 4 并发（`maxConcurrency: 4`）。5 个 reviewer 需要**分两批**：4 + 1。

### Phase 4 双 workflow 串行

```
核心 case workflow（max 10 轮）
  ├── coordinator: 构造/读取 test-execute JSON
  ├── Wave 并行测试（每 Wave 3 个 test-case-subagent）
  ├── Fix Worker（有 failed case 时）
  ├── 增量测试策略（Turn 2+ 只重跑 failed + depends_on 下游）
  └── stagnation check（3 轮不降 → 强制退出）

非核心 case workflow（核心全部 passed 后）
  └── 同上结构
```

### 增量测试策略

```
Turn 1: 执行所有 scope 内的 case
Turn N (N>1):
  1. 读取上一轮的 test-execute JSON
  2. 筛选 status=failed 且已被 fix 的 case（fix worker 标记 status='fixed'）
  3. 加上 depends_on 包含这些 case 的下游 case
  4. 只执行筛选后的 case 子集
  5. 合并到完整的 test-execute JSON 中（保留 passed/skipped 不变）
```

### 现有 agents 处理

当前 `extensions/coding-workflow/agents/` 中有 7 个 `review-*.md` 文件：

| 现有文件 | 与 spec 的关系 | 处理 |
|----------|-------------|------|
| `review-standards.md` | 对应 spec 的 standards-reviewer（Phase 3 阶段二） | **保留**，更新内容以匹配 spec 审查要求 |
| `review-robustness.md` | 对应 spec 的 robustness-reviewer | **保留**，更新 |
| `review-integration.md` | 对应 spec 的 integration-reviewer | **保留**，更新 |
| `review-taste.md` | 对应 spec 的 taste-reviewer | **保留**，更新 |
| `review-architecture.md` | spec 未要求独立 agent，内容可能合并到 spec-plan-conformance | **保留**，待 P3 决定 |
| `review-blr.md` | 对应 spec 的 plan-bl-requirements-reviewer（Phase 2） | **保留**，更新 |
| `review-dataflow.md` | spec 未要求独立 agent | **保留**，待定 |

**结论**：不删除现有 agent 文件。新增的 spec agent 文件命名不冲突（新文件不带 `review-` 前缀）。

## File Structure

### Phase 3（6 个新建）

| 操作 | 文件 | 行数估计 | 说明 |
|------|------|---------|------|
| **create** | `extensions/coding-workflow/agents/spec-plan-conformance-reviewer.md` | ~100 | 阶段一 |
| **create** | `extensions/coding-workflow/agents/simulated-data-generator.md` | ~60 | 阶段一.五 |
| **create** | `extensions/coding-workflow/agents/fallow-reviewer.md` | ~80 | 阶段二 |
| **create** | `extensions/coding-workflow/agents/review-sync-fix-worker.md` | ~100 | 阶段二 |
| **create** | `extensions/coding-workflow/agents/file-fix-subagent.md` | ~60 | 阶段二 |
| **create** | `.pi/workflows/phase3-review-gate.js` | ~200 | Phase 3 三阶段 workflow |

### Phase 4（4 个新建）

| 操作 | 文件 | 行数估计 | 说明 |
|------|------|---------|------|
| **create** | `extensions/coding-workflow/agents/test-execute-coordinator.md` | ~80 | coordinator |
| **create** | `extensions/coding-workflow/agents/test-fix-worker.md` | ~80 | fix worker |
| **create** | `extensions/coding-workflow/agents/test-case-subagent.md` | ~60 | 测试执行 |
| **create** | `.pi/workflows/phase4-test-fix-loop.js` | ~180 | Phase 4 workflow |

### 修改

| 操作 | 文件 | 说明 |
|------|------|------|
| **modify** | `extensions/coding-workflow/lib/gates/test-fix-loop.ts` | 替换为 `pi.__workflowRun` |

## Task List

### Task 2.1: 创建 `spec-plan-conformance-reviewer.md`

**文件**: `extensions/coding-workflow/agents/spec-plan-conformance-reviewer.md`

输入：
- `{topicDir}/spec.md` — 规格文档
- `{topicDir}/plan.md` — 实施计划
- `{topicDir}/use-cases.md` — 业务用例
- `{topicDir}/changes/` — 实际代码变更（通过 git diff）
- 源代码文件

审查维度：
1. **规格覆盖度**：spec 中每个 requirement 是否在 plan 的 File Structure / Task List 中有对应
2. **计划符合性**：代码变更是否与 plan 的 Task List 一致
3. **业务逻辑**：实现是否满足 use-cases.md 中的业务场景
4. **验收标准可测性**：每个 Acceptance Criterion 是否可验证

输出 YAML frontmatter：
```yaml
verdict: pass|fail
must_fix: <number>
review_metrics:
  spec_coverage: <percentage>
  plan_coverage: <percentage>
  ac_coverage: <percentage>
  simulated_data_paths:
    - "path/to/fixture1.json"
    - "path/to/fixture2.json"
issues:
  - id: SPC-001
    severity: must_fix|should_fix
    category: spec_coverage|plan_coverage|business_logic|ac_testability
    description: "..."
    file: "..."
```

**注意**：`simulated_data_paths` 是阶段一.五的输入——如果 reviewer 发现需要模拟数据来测试某些场景，在此字段中列出期望的 fixture 文件路径。

### Task 2.2: 创建 `simulated-data-generator.md`

**文件**: `extensions/coding-workflow/agents/simulated-data-generator.md`

输入：
- 阶段一报告中的 `simulated_data_paths`
- spec.md（理解数据结构）
- 源代码（理解实际数据模型）

输出：
- JSON fixture 文件到 `{topicDir}/changes/reviews/phase-3/simulated_data/`
- 每个 fixture 文件包含符合实际数据模型的模拟数据

Agent 职责：
1. 读取 `simulated_data_paths` 列表
2. 对每个路径，分析需要什么结构的数据
3. 生成合理的模拟数据（边界值、异常值、正常值）
4. 写入文件

### Task 2.3: 创建 `fallow-reviewer.md`

**文件**: `extensions/coding-workflow/agents/fallow-reviewer.md`

Agent 职责：
1. 执行 `fallow audit --format json --base main`（通过 bash 工具）
2. 解析 JSON 输出
3. 将结果转为结构化 review 报告
4. 输出到 `changes/reviews/phase-3/fallow_review_v{round}.md`

YAML frontmatter：
```yaml
verdict: pass|fail
must_fix: <number>
fallow_summary:
  unused_files: <number>
  unused_exports: <number>
  dead_code: <number>
  complexity_hotspots: <number>
```

**注意**：
- fallow CLI 可能不在 PATH 中。agent 需要能通过 `npx fallow` 执行
- 如果 fallow 执行失败，agent 应返回 `verdict: pass, must_fix: 0`（降级跳过，不阻塞）
- fallow 输出可能很大，agent 需要筛选 must_fix 级别的问题

### Task 2.4: 创建 `review-sync-fix-worker.md`

**文件**: `extensions/coding-workflow/agents/review-sync-fix-worker.md`

Agent 职责：
1. 读取 5 份 reviewer 报告（从 `changes/reviews/phase-3/` 目录）
2. 提取所有 must_fix 条目
3. 去重（同一文件同一问题只保留一次）
4. 按优先级排序（spec_coverage > business_logic > code_quality）
5. 按文件分组：同一文件的所有 must_fix 归为一组
6. 判断退出条件：must_fix = 0 → 通过
7. 生成分组修复计划

输出 JSON（通过 schema 参数返回）：
```json
{
  "mustFix": 5,
  "fileGroups": [
    {
      "file": "src/auth/login.ts",
      "issues": [
        { "id": "STD-001", "severity": "must_fix", "description": "..." },
        { "id": "ROB-003", "severity": "must_fix", "description": "..." }
      ]
    },
    {
      "file": "src/api/handler.ts",
      "issues": [
        { "id": "INT-002", "severity": "must_fix", "description": "..." }
      ]
    }
  ]
}
```

### Task 2.5: 创建 `file-fix-subagent.md`

**文件**: `extensions/coding-workflow/agents/file-fix-subagent.md`

Agent 职责：
1. 接收一个文件路径 + 该文件上的 must_fix 列表
2. 按优先级排序（高 → 低）
3. 逐个修复：读取文件 → 理解问题 → 修改代码 → 验证
4. 修复完成后 `git commit -m "fix: resolve {issue_id} in {file}"`

输入格式（通过 prompt 传入）：
```
File: src/auth/login.ts
Issues to fix:
- STD-001: Missing error handling for null user
- ROB-003: Timeout not propagated from inner call
```

**注意**：每个文件独占一个 agent 实例，同一文件的修复串行执行（避免冲突）。不同文件的修复可以并行（但 `parallel()` 不支持动态分组，在 workflow 脚本中用 `for` 循环串行）。

### Task 2.6: 创建 `phase3-review-gate.js` workflow 脚本

**文件**: `.pi/workflows/phase3-review-gate.js`

这是最复杂的 workflow 脚本，包含三阶段嵌套逻辑。

```javascript
const meta = {
  name: "phase3-review-gate",
  description: "Phase 3 Dev Review-Gate: 3-stage nested review with fix loop",
  phases: ["stage1-conformance", "stage1.5-simulated-data", "stage2-review-fix-loop"],
};

// 辅助函数：解析 agent 返回的结构化结果
function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  try { return JSON.parse(String(raw)); } catch { return { verdict: "fail", mustFix: -1 }; }
}

(async () => {
  const { topicDir, maxOuterRounds = 3, maxInnerRounds = 3 } = $ARGS;
  const reviewsDir = `${topicDir}/changes/reviews/phase-3`;

  for (let outer = 1; outer <= maxOuterRounds; outer++) {

    // ── 阶段一：Spec-Plan Conformance ──────────────
    const stage1 = parseResult(
      await agent({
        prompt: `Stage 1: Spec-plan conformance review.
Topic: ${topicDir}, Outer round: ${outer}
Read spec.md, plan.md, use-cases.md, and source code.
Check every spec requirement has implementation.
Report as JSON with: verdict, mustFix, reviewMetrics, simulatedDataPaths, issues.
Write detailed review to: ${reviewsDir}/spec_conformance_v${outer}.md`,
        schema: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["pass", "fail"] },
            mustFix: { type: "number" },
            reviewMetrics: {
              type: "object",
              properties: {
                specCoverage: { type: "number" },
                planCoverage: { type: "number" },
                acCoverage: { type: "number" },
                simulatedDataPaths: { type: "array", items: { type: "string" } },
              },
            },
          },
          required: ["verdict", "mustFix"],
        },
        description: `phase3-stage1-outer${outer}`,
      })
    );

    if (stage1.mustFix > 0 || stage1.verdict !== "pass") {
      return {
        passed: false, stage: 1, outer,
        lastMustFix: stage1.mustFix,
        fixGuidance: "Stage 1 FAILED: code does not conform to spec/plan. Re-code and resubmit.",
      };
    }

    // ── 阶段一.五：Simulated Data Generation ───────
    const simPaths = stage1.reviewMetrics?.simulatedDataPaths ?? [];
    if (simPaths.length > 0) {
      await agent({
        prompt: `Generate simulated data fixtures.
Topic: ${topicDir}
Paths to generate: ${JSON.stringify(simPaths)}
Read spec.md for data structure understanding.
Write JSON fixtures to: ${reviewsDir}/simulated_data/`,
        description: `phase3-stage1.5-outer${outer}`,
      });
    }

    // ── 阶段二：Code Quality Review-Fix Loop ───────
    let lastMustFix = -1;
    let stagnationCount = 0;

    for (let inner = 1; inner <= maxInnerRounds; inner++) {

      // 并行 5 reviewer（分两批：4 + 1，因为 maxConcurrency=4）
      const batch1 = await parallel([
        agent({
          prompt: `Standards review. Topic: ${topicDir}, Round: ${outer}-${inner}.
Read source files. Check coding standards, lint compliance, type safety.
Report JSON: { verdict, mustFix, issues }.
Write to: ${reviewsDir}/standards_review_v${outer}-${inner}.md`,
          schema: { /* verdict, mustFix */ },
          description: `standards-r${outer}-${inner}`,
        }),
        agent({
          prompt: `Taste review. Topic: ${topicDir}, Round: ${outer}-${inner}.
Check code taste: naming, structure, patterns.
Report JSON: { verdict, mustFix, issues }.
Write to: ${reviewsDir}/taste_review_v${outer}-${inner}.md`,
          schema: { /* verdict, mustFix */ },
          description: `taste-r${outer}-${inner}`,
        }),
        agent({
          prompt: `Robustness review. Topic: ${topicDir}, Round: ${outer}-${inner}.
Check error handling, edge cases, timeouts.
Report JSON: { verdict, mustFix, issues }.
Write to: ${reviewsDir}/robustness_review_v${outer}-${inner}.md`,
          schema: { /* verdict, mustFix */ },
          description: `robustness-r${outer}-${inner}`,
        }),
        agent({
          prompt: `Fallow review. Topic: ${topicDir}, Round: ${outer}-${inner}.
Run: npx fallow audit --format json --base main
Convert JSON to review. Report JSON: { verdict, mustFix, issues }.
Write to: ${reviewsDir}/fallow_review_v${outer}-${inner}.md`,
          schema: { /* verdict, mustFix */ },
          description: `fallow-r${outer}-${inner}`,
        }),
      ]);

      const batch2 = await agent({
        prompt: `Integration review. Topic: ${topicDir}, Round: ${outer}-${inner}.
Check module boundaries, API contracts, data flow.
Report JSON: { verdict, mustFix, issues }.
Write to: ${reviewsDir}/integration_review_v${outer}-${inner}.md`,
        schema: { /* verdict, mustFix */ },
        description: `integration-r${outer}-${inner}`,
      });

      // ── Fix Worker 汇总 ───────────────────────
      const fixPlan = parseResult(
        await agent({
          prompt: `Review sync fix worker. Topic: ${topicDir}, Round: ${outer}-${inner}.
Read all 5 review reports from ${reviewsDir}/.
Aggregate must_fix items. De-duplicate. Sort by priority. Group by file.
Report JSON: { mustFix, fileGroups: [{ file, issues }] }.
If mustFix=0, just return { mustFix: 0 }.`,
          schema: {
            type: "object",
            properties: {
              mustFix: { type: "number" },
              fileGroups: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    file: { type: "string" },
                    issues: { type: "array", items: { type: "object" } },
                  },
                },
              },
            },
            required: ["mustFix"],
          },
          description: `fix-worker-r${outer}-${inner}`,
        })
      );

      if (fixPlan.mustFix <= 0) {
        return { passed: true, outer, inner, lastMustFix: 0 };
      }

      // ── 按文件串行修复 ────────────────────────
      const fileGroups = fixPlan.fileGroups ?? [];
      for (const group of fileGroups) {
        await agent({
          prompt: `Fix issues in ${group.file}.
Topic: ${topicDir}
Issues: ${JSON.stringify(group.issues)}
Fix each issue. After fixing, run: git add ${group.file} && git commit -m "fix: resolve review issues in ${group.file}"`,
          description: `file-fix-${group.file.replace(/[\/\\]/g, "_")}`,
        });
      }

      // ── Stagnation check ───────────────────────
      if (lastMustFix >= 0 && fixPlan.mustFix >= lastMustFix) {
        stagnationCount++;
        if (stagnationCount >= 2) {
          return {
            passed: false, stage: 2, outer, inner,
            lastMustFix: fixPlan.mustFix,
            stagnation: true,
            fixGuidance: `Stagnation: must_fix did not decrease for ${stagnationCount} rounds.`,
          };
        }
      } else {
        stagnationCount = 0;
      }
      lastMustFix = fixPlan.mustFix;
    }

    // 内层循环达到 maxInnerRounds
    return {
      passed: false, stage: 2, outer,
      lastMustFix,
      maxInnerRounds: true,
      fixGuidance: `Inner loop reached max rounds (${maxInnerRounds}).`,
    };
  }

  return {
    passed: false,
    lastMustFix: -1,
    maxOuterRounds: true,
    fixGuidance: `Outer loop reached max rounds (${maxOuterRounds}).`,
  };
})();
```

**注意**：
- 脚本较长（~200 行），但逻辑清晰，分为三个明确的阶段
- 每个阶段的 agent prompt 包含完整的审查指令，不依赖 agent 文件发现
- `parallel()` 调用 4 个 reviewer（第二阶段分批），第 5 个单独调用
- Fix Worker 返回的 `fileGroups` 驱动按文件修复

### Task 2.7: 创建 `test-execute-coordinator.md`

**文件**: `extensions/coding-workflow/agents/test-execute-coordinator.md`

Agent 职责：
1. 读取 `test_cases_template.json`
2. 根据 scope（core/noncore）筛选 case
3. 根据增量策略筛选重跑的 case 子集（Turn 2+）
4. 构造 test-execute JSON（版本化：`test-execute-v{round}-{scope}.json`）
5. 分派 Wave（每 Wave 最多 3 个 `test-case-subagent`）
6. 汇总所有 Wave 的结果
7. 返回结构化结果：`{ total, passed, failed, skipped, fixed, cases }`

**增量策略实现**：
```
Turn 1: all cases in scope
Turn N (N>1):
  1. Read previous round's test-execute JSON
  2. Find cases with status='fixed' (fixed in previous round)
  3. Find cases that depend_on any fixed case
  4. Union: fixed + dependents = rerun set
  5. If rerun set is empty, all remaining are passed → return { failed: 0 }
```

### Task 2.8: 创建 `test-fix-worker.md`

**文件**: `extensions/coding-workflow/agents/test-fix-worker.md`

Agent 职责：
1. 接收 failed case 列表
2. 分析失败原因（读测试输出、代码、相关源文件）
3. 修复代码或测试（优先修复代码，除非测试本身有 bug）
4. 更新 test-execute JSON 中 fixed case 的 status 为 `'fixed'`
5. `git commit`

### Task 2.9: 创建 `test-case-subagent.md`

**文件**: `extensions/coding-workflow/agents/test-case-subagent.md`

Agent 职责：
1. 接收一组 test case（3 个以内）
2. 每个 case 按 `test_cases_template.json` 中定义的步骤执行
3. 记录结果：`passed` / `skipped` / `failed`
4. failed 时记录 evidence（错误输出、断言失败信息）
5. 返回结果列表

### Task 2.10: 创建 `phase4-test-fix-loop.js` workflow 脚本

**文件**: `.pi/workflows/phase4-test-fix-loop.js`

```javascript
const meta = {
  name: "phase4-test-fix-loop",
  description: "Phase 4 Test-Fix Loop: core then noncore serial workflows",
  phases: ["core-test-fix", "noncore-test-fix"],
};

async function runTestFixLoop(scope, topicDir, maxRounds, maxStagnation) {
  let lastFailed = -1;
  let stagnationCount = 0;

  for (let round = 1; round <= maxRounds; round++) {
    // ── Coordinator: 构造 JSON + 分派 Wave ──────
    const coordResult = parseResult(
      await agent({
        prompt: `Test execute coordinator. Scope: ${scope}, Round: ${round}.
Topic: ${topicDir}
${round > 1 ? `Previous round had failures. Apply incremental strategy: only rerun fixed + dependent cases.` : `Run all ${scope} cases.`}
Read test_cases_template.json from ${topicDir}/.
Dispatch Waves of test execution.
Return JSON: { total, passed, failed, skipped, fixed, cases: [...] }
Write test-execute JSON to: ${topicDir}/changes/reviews/phase-4/test-execute-v${round}-${scope}.json`,
        schema: {
          type: "object",
          properties: {
            total: { type: "number" },
            passed: { type: "number" },
            failed: { type: "number" },
            skipped: { type: "number" },
            fixed: { type: "number" },
          },
          required: ["total", "passed", "failed"],
        },
        description: `test-coord-${scope}-r${round}`,
      })
    );

    const failed = coordResult.failed ?? 0;
    const passed = coordResult.passed ?? 0;

    if (failed === 0) {
      return { passed: true, round, passed, total: coordResult.total };
    }

    // ── Fix Worker ─────────────────────────────
    await agent({
      prompt: `Test fix worker. Scope: ${scope}, Round: ${round}.
Topic: ${topicDir}
Read test-execute JSON: ${topicDir}/changes/reviews/phase-4/test-execute-v${round}-${scope}.json
Fix all failed cases. Analyze root cause, fix code or test.
Update test-execute JSON: mark fixed cases as status='fixed'.
Git commit fixes.`,
      description: `test-fix-${scope}-r${round}`,
    });

    // ── Stagnation check ───────────────────────
    if (lastFailed >= 0 && failed >= lastFailed) {
      stagnationCount++;
      if (stagnationCount >= maxStagnation) {
        return {
          passed: false, round,
          stagnation: true,
          lastFailed: failed,
          fixGuidance: `Stagnation: ${stagnationCount} rounds with no improvement.`,
        };
      }
    } else {
      stagnationCount = 0;
    }
    lastFailed = failed;
  }

  return {
    passed: false,
    maxRounds: true,
    lastFailed,
    fixGuidance: `Max rounds (${maxRounds}) reached with ${lastFailed} failures remaining.`,
  };
}

(async () => {
  const { topicDir, maxRounds = 10, maxStagnation = 3 } = $ARGS;

  // ── Workflow 1: Core cases ──────────────────────
  const core = await runTestFixLoop("core", topicDir, maxRounds, maxStagnation);
  if (!core.passed) {
    return { core, noncore: null, overall: false };
  }

  // ── Workflow 2: Non-core cases ──────────────────
  const noncore = await runTestFixLoop("noncore", topicDir, maxRounds, maxStagnation);
  return {
    core,
    noncore,
    overall: noncore.passed,
  };
})();
```

**注意**：
- `runTestFixLoop` 是脚本内部函数，不是独立的 workflow。core 和 noncore 在同一个 workflow 脚本中串行执行
- 增量策略在 coordinator agent 的 prompt 中指导，由 agent 自行判断哪些 case 需要重跑
- Wave 并行测试在 coordinator agent 内部实现（coordinator 自己用 bash 并行启动测试）

### Task 2.11: TestFixLoopGate 替换实现

**文件**: `extensions/coding-workflow/lib/gates/test-fix-loop.ts`

与 ReviewGate 类似：
1. 检测 `pi.__workflowRun`
2. 可用 → 调用 `pi.__workflowRun("phase4-test-fix-loop", args, signal, 15 * 60_000)`（15 分钟超时，test-fix 可能较长）
3. 不可用 → 降级到现有 `runTestFixLoop`
4. 解析 scriptResult → 返回 GateResult

### Task 2.12: Lint 所有 workflow 脚本

```bash
pi workflow-lint phase3-review-gate
pi workflow-lint phase4-test-fix-loop
```

确认无 error 级别的 lint finding。

## Dependency Graph

```
Task 2.1 (spec-plan-conformance) ─┐
Task 2.2 (simulated-data) ────────┤
Task 2.3 (fallow-reviewer) ───────┤──→ Task 2.6 (phase3 workflow) ──→ Task 2.12 (lint)
Task 2.4 (review-sync-fix-worker)─┤
Task 2.5 (file-fix-subagent) ─────┘

Task 2.7 (test-coordinator) ──┐
Task 2.8 (test-fix-worker) ───┤──→ Task 2.10 (phase4 workflow) ──→ Task 2.11 (TestFixLoopGate) ──→ Task 2.12
Task 2.9 (test-case-subagent)─┘
```

可并行：
- Phase 3 agent 文件（Task 2.1-2.5）和 Phase 4 agent 文件（Task 2.7-2.9）之间无依赖
- Task 2.6 和 Task 2.10 可以并行开发
- 但都需要对应的 agent 文件先完成

## Acceptance Criteria

1. Phase 3 三阶段 workflow 正确运行
   - 阶段一 FAIL 时正确退出，返回打回主 agent 的修复指引
   - 阶段一.五 在有 `simulatedDataPaths` 时执行
   - 阶段二并行 reviewer（分批 4+1）正确执行
   - Fix Worker 汇总 + 按文件修复正确
   - Stagnation 检查（2 轮不降）和 max rounds 退出正确
2. Phase 4 双 workflow 串行正确（core 全部 passed 后才进入 noncore）
3. Phase 4 增量测试策略生效（第 2 轮起只重跑 failed + dependent）
4. Phase 4 stagnation 检查（3 轮不降）正确
5. 所有 workflow 脚本通过 `script-lint`
6. 降级逻辑正确：workflow extension 未安装时回退到 `runSingleAgent`
7. 所有新 agent 文件存在且内容完整

## 验证命令

```bash
# 类型检查
pnpm --filter @zhushanwen/pi-coding-workflow typecheck

# Lint
pnpm --filter @zhushanwen/pi-coding-workflow lint

# Workflow lint（需 Pi 运行时）
pi workflow-lint phase3-review-gate
pi workflow-lint phase4-test-fix-loop

# 手动验证
/coding-workflow test full pipeline feature
# Phase 3 gate: 观察三阶段执行
# Phase 4 gate: 观察 test-fix 循环
```

## 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| Phase 3 workflow 脚本过长（>200 行） | 维护困难 | 拆分为子函数（`runStage1`, `runStage15`, `runStage2Loop`） |
| `parallel()` 4 并发限制 | 5 reviewer 需分两批 | 已在设计中处理（4+1 分批） |
| `agent()` 返回值不是结构化 JSON | `parseResult` 失败 | fallback 到从 review 文件文本解析 must_fix |
| fallow CLI 执行失败 | fallow-reviewer 报错 | agent 内部 catch，返回 `verdict: pass, mustFix: 0` |
| Phase 4 test-fix 循环 agent 耗时长 | `runAndWait` 超时 | Phase 4 超时放宽到 15 分钟 |
| 增量测试策略由 agent prompt 指导，可能不精确 | 重跑范围不准 | 先用最简策略（只重跑 failed），后续迭代优化 |
| coordinator agent 内部无法真正并行 Wave | 测试串行执行 | coordinator 返回结构化测试指令，由主 agent/bash 执行 |
