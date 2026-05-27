---
verdict: pass
complexity: L1
---

# Self-Evolution Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 端到端打通 evolution-engine 的完整闭环（analyzer → judge → apply → rollback），验证质量，补充缺失模板。

**Architecture:** Phase 3 已搭建了 evolution-engine 的完整骨架（2291 行 TS）。本次 Phase 4 不从零实现，而是：验证 → 修复 → 补充。核心路径是 `Python analyzer` → `JSON report` → `LLM Judge (pi subprocess)` → `suggestions` → `apply/rollback`。所有操作都在 extension 进程内完成（Judge 通过 spawn 子进程）。

**Tech Stack:** TypeScript（Pi Extension API）、Python 3（pi-session-analyzer）、Node.js child_process（spawn pi --mode json）

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `evolution-engine/src/templates/merge-reviewer.txt` | create | BG1 | 缺失的第 4 个 Judge 模板 |
| `evolution-engine/src/judge.ts` | modify | BG1 | 修复 TARGET_TEMPLATE 映射，支持 merge-reviewer |
| `evolution-engine/src/commands.ts` | modify | BG1 | 修复 analyzer 调用错误处理、改进 evolve 命令反馈 |
| `evolution-engine/src/applier.ts` | modify | BG1 | 增强 diff 冲突时的错误信息和 fallback 策略 |
| `evolution-engine/src/monitor.ts` | modify | BG1 | 日志和可观测性增强 |
| `evolution-engine/src/index.ts` | modify | BG1 | 注册 merge-reviewer 相关 command、改进 session_start 事件 |
| `evolution-engine/src/types.ts` | modify | BG1 | 新增 merge-reviewer 相关类型 |
| `evolution-engine/tests/integration.test.mts` | modify | BG1 | 修复硬编码路径 |
| `evolution-engine/docs/e2e-test-log.md` | create | EG2 | E2E 闭环测试记录 |
| `evolution-engine/docs/d3.3-quality-assessment.md` | create | EG2 | D3.3 质量评估记录 |

## Spec Coverage Matrix

| Spec AC | Interface Method | Data Flow | Task |
|---------|-----------------|-----------|------|
| D4.1 evolution-engine extension | handleEvolve / handleEvolveApply / handleEvolveRollback / handleEvolveStats | commands.ts → judge.ts → applier.ts | Task 1, Task 2 (E2E) |
| D4.2 四个 Command | index.ts registerCommand | N/A | Task 1 (verify existing) |
| D4.3 审批交互流程 | handleEvolveApply (list/apply/skip) | commands.ts → applier.ts | Task 4 |
| D4.4 安全回滚机制 | rollbackSuggestion | applier.ts → git revert/copyFile | Task 2 (E2E verify) |
| D3.3 建议质量评估 | runJudge → parseJudgeOutput | judge.ts → pi subprocess | Task 5 |
| merge-reviewer 模板 | buildJudgeInput TARGET_TEMPLATE | judge.ts → templates/merge-reviewer.txt | Task 4 |
| Python analyzer 接口验证 | handleEvolve → execFileSync | commands.ts → analyze.py | Task 1, Task 2 (E2E) |

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| D4.1 evolution-engine extension | adopted | Task 1, Task 2 (E2E verify) |
| D4.2 四个 Command | adopted | Task 1 |
| D4.3 审批交互流程 | adopted | Task 4 (diff preview) |
| D4.4 安全回滚机制 | adopted | Task 2 (E2E verify) |
| D3.3 建议质量评估 | adopted | Task 5 |
| merge-reviewer 模板 | adopted | Task 4 |
| P5.5 自动触发规则 | adopted (already implemented) | Task 1 (verify) |
| _render 协议集成 | postponed | Phase 5 前置准备，不在本次 scope |
| Workflow 集成 | postponed | 依赖 workflow extension 稳定版本 |
| P5.1-P5.4 高级特性 | postponed | 需要 Phase 4 稳定运行 4+ 周数据 |
| evolve-report command 别名 | postponed | 核心命令 evolve-stats 已覆盖功能，别名非 Phase 4 必须 |
| 交互式审批（TUI 逐条确认） | postponed | 依赖 pi TUI 组件复杂度高，推迟到后续 Phase |

## Interface Contracts

### Module: commands

#### Function: handleEvolve

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| handleEvolve | (params: EvolveCommandParams, dirs: Dirs) -> Promise<CommandResult> | CommandResult | analyzer 脚本不存在、无近期报告、Judge 超时 | D4.1 |
| handleEvolveApply | (params: EvolveApplyCommandParams, dirs: Dirs) -> Promise<CommandResult> | CommandResult | 无 pending 建议、index 越界、apply 失败 | D4.3 |
| handleEvolveStats | (evolutionDir: string) -> CommandResult | CommandResult | 无 daily 数据、损坏 JSON 文件 | D4.2 |
| handleEvolveRollback | (index: number, dirs: Dirs) -> Promise<CommandResult> | CommandResult | 无历史、非 apply 类型记录、备份文件丢失 | D4.4 |

### Module: judge

#### Function: runJudge

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| buildJudgeInput | (report: Phase2Report, target: JudgeInput["target"], tmpDir: string) -> JudgeInput | JudgeInput | 空 report、target="all" | D4.1 |
| runJudge | (input: JudgeInput, templateDir: string) -> Promise<EvolutionSuggestion[]> | EvolutionSuggestion[] | pi 不在 PATH、子进程超时、非 JSON 输出 | D3.3 |
| parseJudgeOutput | (raw: string) -> EvolutionSuggestion[] | EvolutionSuggestion[] | markdown 包裹、无效 confidence、缺字段 | D3.3 |

### Module: applier

#### Function: applySuggestion

| Method | Signature | Returns | Edge Cases | Spec Ref |
|--------|-----------|---------|------------|----------|
| applySuggestion | (suggestion: EvolutionSuggestion, backupDir: string) -> Promise<ApplyResult> | ApplyResult | 路径不在白名单、文件不存在、diff 冲突 | D4.4 |
| rollbackSuggestion | (entry: HistoryEntry) -> Promise<RollbackResult> | RollbackResult | 备份文件不存在、git revert 失败 | D4.4 |
| applyUnifiedDiff | (filePath: string, diff: string) -> ApplyResult | ApplyResult | 无 hunk、冲突、文件被修改 | D4.4 |

---

## Task List

### Task 1: E2E 验证与接口对齐

**Type:** backend

**Files:**
- Verify: `evolution-engine/src/commands.ts` (analyzer 调用逻辑)
- Verify: `evolution-engine/src/judge.ts` (report 键匹配)
- Verify: `evolution-engine/src/applier.ts` (path 白名单、diff 应用)
- Modify: `evolution-engine/src/commands.ts` (改进错误处理)
- Modify: `evolution-engine/src/monitor.ts` (日志增强)
- Modify: `evolution-engine/tests/integration.test.mts` (修复硬编码路径)

- [ ] **Step 1: 验证 analyzer CLI 接口**

`analyze.py` 接受 `--since`, `--format json`, `--output` 参数，输出顶层键包含 `tool_stats`, `token_stats`, `skill_stats`, `error_stats`, `user_patterns`, `actionable_issues`, `skill_health`。

运行验证：
```bash
python3 ~/.pi/agent/scripts/pi-session-analyzer/analyze.py --since 7d --format json --output /tmp/test-report.json
```
检查输出 JSON 的顶层键是否与 `judge.ts` 的 `extractReportSubset` 引用的键一致。

- [ ] **Step 2: 修复 integration test 硬编码路径**

当前 `tests/integration.test.mts` 第 12 行硬编码了 `feat-self-evolution-3` 路径：
```typescript
const srcDir = "/Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-self-evolution-3/evolution-engine/src";
```
改为相对于 test 文件的动态路径：
```typescript
const srcDir = new URL("../src", import.meta.url).pathname;
```

- [ ] **Step 3: 改进 handleEvolve 的 analyzer 错误信息**

`commands.ts` 中 `execFileSync` 调用 analyzer 时，如果脚本不存在，错误信息不够明确。在调用前增加存在性检查：

```typescript
if (!existsSync(ANALYZER_SCRIPT)) {
    throw new Error(
        `Session analyzer not found at ${ANALYZER_SCRIPT}. ` +
        `Please install pi-session-analyzer first.`
    );
}
```

- [ ] **Step 4: 为 monitor.ts 增加日志**

在 `checkAutoTriggerRules` 入口和每个规则检查后添加 file logger 调用（复用 `shared/logger.ts`）：

```typescript
import { createLogger } from "../../shared/logger.js";
const log = createLogger("evolution-monitor");

// 在 checkAutoTriggerRules 入口:
log.info(`Auto-trigger check: ${daily.length} daily files loaded`);

// 在每个规则检查后:
if (result.hit) {
    log.info(`Rule "${name}" triggered: ${result.detail}`);
}
```

- [ ] **Step 5: 运行现有测试验证**

```bash
cd evolution-engine && node --experimental-strip-types tests/integration.test.mts
```

- [ ] **Step 6: Commit**

```bash
git add evolution-engine/src/commands.ts evolution-engine/src/monitor.ts evolution-engine/tests/integration.test.mts
git commit -m "fix: improve error messages, fix test paths, add monitor logging"
```

### Task 2: E2E 闭环验证

**Type:** backend (integration verification)

**Depends on:** Task 1

**Files:**
- Verify: `evolution-engine/` extension 在 pi 中可加载
- Verify: `~/.pi/agent/extensions/evolution-engine` symlink 存在
- Create: `evolution-engine/docs/e2e-test-log.md` (E2E 测试记录)

- [ ] **Step 1: 安装 evolution-engine 到 pi**

```bash
ln -sf /Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-self-evolution-4/evolution-engine ~/.pi/agent/extensions/evolution-engine
```

验证 symlink 正确：
```bash
ls -la ~/.pi/agent/extensions/evolution-engine
```

- [ ] **Step 2: 验证 pi 能加载 extension**

启动 pi，检查 extension 加载日志：
```bash
pi --mode json -p "echo hello" 2>&1 | grep -i evolution
```

预期：无加载错误（如果有，根据错误信息修复 `index.ts` 的工厂函数签名或 import 路径）。

- [ ] **Step 3: 运行 /evolve 做完整闭环测试**

在 pi 交互 session 中执行：

```
/evolve
```

记录输出（建议数量、每条建议的 title/severity/confidence）。

如果报错，记录错误信息和修复方案。

- [ ] **Step 4: 运行 /evolve-apply 查看详情并应用一条**

```
/evolve-apply action=list
/evolve-apply action=apply index=0
```

验证：
- list 输出包含 diff 预览
- apply 后目标文件被修改
- 备份文件存在

- [ ] **Step 5: 运行 /evolve-rollback 回滚**

```
/evolve-rollback index=1
```

验证：
- 文件内容恢复到 apply 前
- history 记录了 rollback 操作

- [ ] **Step 6: 记录 E2E 测试结果**

将完整测试过程写入 `evolution-engine/docs/e2e-test-log.md`：

```markdown
# E2E Test Log

**Date:** {date}
**Pi version:** {pi --version}

## /evolve
- Status: PASS/FAIL
- Suggestions generated: {N}
- Error (if any): {error}

## /evolve-apply list
- Status: PASS/FAIL
- Pending count: {N}

## /evolve-apply apply
- Status: PASS/FAIL
- File modified: {path}
- Backup created: {path}

## /evolve-rollback
- Status: PASS/FAIL
- File restored: {path}
```

- [ ] **Step 7: Commit**

```bash
git add evolution-engine/docs/e2e-test-log.md
 git commit -m "docs: add E2E test log for evolution-engine"
```

### Task 3: 修复 E2E 发现的问题

**Type:** backend (bug fix)

**Depends on:** Task 2

**Files:**
- Modify: 根据实际发现的问题决定（预计涉及 `commands.ts`、`judge.ts`、`index.ts` 中的 1-2 个文件）

**修复轮次上限：2 轮**（超过则升级为人工决策）

- [ ] **Step 1: 从 E2E log 中提取问题清单**

读取 `evolution-engine/docs/e2e-test-log.md`，整理所有 FAIL 项。

- [ ] **Step 2: 逐项修复**

常见预期问题（根据 spec 风险评估）：
- analyzer 调用参数不匹配（如 `--output` 路径格式）
- pi `--mode json` 输出格式与 JSONL 解析器不匹配
- Judge 输出被额外文字包裹导致 `parseJudgeOutput` 失败
- extension 工厂函数签名与 pi runtime 期望不匹配

每个修复后立即重新运行对应的 E2E 步骤验证。

- [ ] **Step 3: 回归测试**

```bash
cd evolution-engine && node --experimental-strip-types tests/integration.test.mts
```

- [ ] **Step 4: 更新 E2E log**

在 `e2e-test-log.md` 中追加修复记录。

- [ ] **Step 5: 类型检查**

```bash
cd evolution-engine && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add evolution-engine/src/ evolution-engine/docs/e2e-test-log.md
git commit -m "fix: resolve E2E issues found in closed-loop testing"
```

### Task 4: 补充 merge-reviewer 模板 + 增强审批交互

**Type:** backend

**Depends on:** Task 3

**Files:**
- Create: `evolution-engine/src/templates/merge-reviewer.txt`
- Modify: `evolution-engine/src/judge.ts` (TARGET_TEMPLATE 映射)
- Modify: `evolution-engine/src/types.ts` (JudgeInput.target 类型)
- Modify: `evolution-engine/src/commands.ts` (改进 list 详情展示)

- [ ] **Step 1: 创建 merge-reviewer 模板**

`evolution-engine/src/templates/merge-reviewer.txt`：

```
你是 Pi Agent 的进化分析器，专门评估代码合并和 PR 质量并生成优化建议。

## 输入数据

以下是最近 N 天的信号数据（JSON 格式），包含：
- 工具调用统计（edit 重试率、read 重复率）
- 错误模式（merge 冲突、test 失败）
- 用户交互模式（代码审查反馈、修改频率）

## 评判维度

请从以下 3 个维度分析：

1. **合并效率**：PR 合并后的回退率、hotfix 频率，是否存在频繁合并后又回退的模式
2. **代码审查模式**：哪些类型的改动经常被审查者要求修改，是否可以通过在 CLAUDE.md 中添加规则来减少往返
3. **工具使用优化**：合并流程中的工具调用是否高效（如 edit 重试率是否偏高）

## 输出格式

输出一个 JSON 数组，每个元素是一条进化建议。严格遵循以下 schema：

```json
[
  {
    "id": "uuid-v4-string",
    "target": "claude-md",
    "targetPath": "要修改的 CLAUDE.md 或 skill 文件绝对路径",
    "severity": "high | medium | low",
    "confidence": 0.0-1.0,
    "title": "简短标题",
    "description": "建议内容描述",
    "rationale": "基于输入数据的具体数值支撑",
    "diff": "unified diff 格式的修改内容"
  }
]
```

字段说明：
- `id`: 生成一个随机 UUID v4
- `target`: "claude-md" 或 "skill"
- `targetPath`: 必须是相关文件的绝对路径
- `severity`: "high" = 严重影响质量, "medium" = 可改进, "low" = 优化建议
- `confidence`: 置信度，必须 >= 0.6 才输出该建议
- `diff`: 标准 unified diff 格式

## 约束

- confidence < 0.6 的建议不要输出
- 如果没有值得建议的改进，输出空数组 []
- 只输出 JSON，不要输出任何其他文字
```

- [ ] **Step 2: 更新 TARGET_TEMPLATE 映射**

在 `judge.ts` 中添加 `merge-reviewer` target：

```typescript
const TARGET_TEMPLATE: Record<JudgeInput["target"], string> = {
    "all": "session-quality.txt",
    "claude-md": "prompt-optimize.txt",
    "skill": "skill-health.txt",
    "merge-reviewer": "merge-reviewer.txt",
};
```

- [ ] **Step 3: 更新类型定义**

在 `types.ts` 中 `JudgeInput` 的 `target` 字段类型添加 `"merge-reviewer"`：

```typescript
// 找到 JudgeInput.target 的联合类型，添加 "merge-reviewer"
target: "all" | "claude-md" | "skill" | "merge-reviewer";
```

- [ ] **Step 4: 改进 handleEvolveApply list 的详情展示**

在 `commands.ts` 的 list 分支中，将 diff 预览（前 10 行）也展示出来，让用户在不看源文件的情况下能判断建议质量：

```typescript
const diffPreview = suggestion.diff
    ? suggestion.diff.split("\n").slice(0, 10).join("\n")
    : "(no diff)";
// 在 contentLines 构建中添加 diffPreview
```

- [ ] **Step 5: 运行测试确认无回归**

```bash
cd evolution-engine && node --experimental-strip-types tests/integration.test.mts
```

- [ ] **Step 6: 类型检查**

```bash
cd evolution-engine && npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add evolution-engine/src/templates/merge-reviewer.txt evolution-engine/src/judge.ts evolution-engine/src/types.ts evolution-engine/src/commands.ts
git commit -m "feat: add merge-reviewer template and enhance apply list details"
```

### Task 5: LLM Judge 质量评估（D3.3 门控）

**Type:** backend (manual verification)

**Depends on:** Task 3, Task 4

**Files:**
- Verify: `evolution-engine/src/judge.ts` (runJudge 输出质量)
- Create: `evolution-engine/docs/d3.3-quality-assessment.md` (评估记录)

- [ ] **Step 1: 准备测试数据**

确保 `~/.pi/agent/evolution-data/daily/` 下有最近 7 天的数据文件。如果没有，运行一次 pi session 产生 usage-tracker 数据。

检查数据存在：
```bash
ls ~/.pi/agent/evolution-data/daily/ | tail -7
```

- [ ] **Step 2: 运行 analyzer 生成报告**

```bash
python3 ~/.pi/agent/scripts/pi-session-analyzer/analyze.py --since 7d --format json --output /tmp/phase4-test-report.json
```

验证报告非空且包含预期键：
```bash
python3 -c "import json; r=json.load(open('/tmp/phase4-test-report.json')); print(list(r.keys()))"
```

预期输出应包含: `tool_stats`, `token_stats`, `skill_stats`, `error_stats`, `user_patterns`, `actionable_issues`, `skill_health`

- [ ] **Step 3: 使用 Judge 模板进行质量测试**

手动运行 pi 子进程模拟 Judge 调用（不依赖 extension 注册）：

```bash
pi --mode json -p --model router-openai/glm-5.1 --no-session \
  --append-system-prompt "$(cat evolution-engine/src/templates/session-quality.txt)" \
  "分析以下信号数据，生成进化建议：$(cat /tmp/phase4-test-report.json)"
```

收集输出，评估以下维度（每项 1-10 分）：
- **格式合规性**：输出是否是合法 JSON 数组
- **字段完整性**：每条建议是否包含所有必需字段（target, targetPath, severity, confidence, title, description, rationale, diff）
- **置信度合理性**：confidence 值是否合理（0.6-1.0 范围内）
- **建议可操作性**：diff 是否可以实际应用（格式正确、路径合理）
- **相关性**：建议是否与输入数据中的实际模式相关

评分门控：综合分 ≥ 7/10 才通过。

- [ ] **Step 4: 记录评估结果**

将评估结果写入 `evolution-engine/docs/d3.3-quality-assessment.md`：

```markdown
# D3.3 LLM Judge Quality Assessment

**Date:** {date}
**Model:** router-openai/glm-5.1
**Input:** phase4-test-report.json ({N} days data)

## Scores

| Dimension | Score | Notes |
|-----------|-------|-------|
| 格式合规性 | x/10 | ... |
| 字段完整性 | x/10 | ... |
| 置信度合理性 | x/10 | ... |
| 建议可操作性 | x/10 | ... |
| 相关性 | x/10 | ... |
| **综合** | **x/10** | ... |

## Sample Output

{附上 1-2 条典型建议的原文}

## Verdict: PASS/FAIL
```

- [ ] **Step 5: 如果质量不达标，优化 prompt**

如果综合分 < 7：
1. 在模板中添加 few-shot 示例（1 条完整的示例建议）
2. 强化约束条件（如 "diff 必须是可实际应用的 unified diff，不是伪代码"）
3. 重新运行 Step 3 评估

- [ ] **Step 6: Commit 评估记录**

```bash
git add evolution-engine/docs/d3.3-quality-assessment.md
git commit -m "docs: add D3.3 LLM Judge quality assessment"
```

---

## Execution Groups

#### BG1: Evolution Engine 代码修复与增强

**Description:** 后端 TypeScript 修改（验证、修复、模板补充），文件关联紧密（同一个 extension）。

**Tasks:** Task 1, Task 3, Task 4

**Files (预估):** 8 个文件（2 create + 6 modify）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose → general-purpose → general-purpose |
| Model | 按 taskComplexity 自动选择（executor: high、tdd-coder: medium） |
| 注入上下文 | Task 描述 + spec D4.1-D4.3 + 编码规范（禁止 any、文件上限 1000 行） |
| 读取文件 | evolution-engine/src/*.ts, usage-tracker/src/types.ts, shared/logger.ts |
| 修改/创建文件 | evolution-engine/src/*.ts, evolution-engine/src/templates/merge-reviewer.txt |

**Execution Flow (BG1 内部):** 串行派遣。

  Task 1 (验证与接口对齐):
    1. general-purpose (read xyz-harness-test-driven-development) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 实现修复
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

  Task 3 (E2E 修复 buffer, depends on Task 2 E2E 结果):
    1. general-purpose (read xyz-harness-backend-dev) → 修复 E2E 发现的问题
    2. general-purpose (read xyz-harness-expert-reviewer) → 回归检查

  Task 4 (merge-reviewer + 增强, depends on Task 3):
    1. general-purpose (read xyz-harness-test-driven-development) → 写失败测试
    2. general-purpose (read xyz-harness-backend-dev) → 创建模板 + 修改类型映射
    3. general-purpose (read xyz-harness-expert-reviewer) → spec 合规检查

**Dependencies:** 无

**设计细节:** Task 1 是基础验证。Task 2（E2E）和 Task 3（修复）形成闭环。Task 4 补充缺失功能。

#### EG2: Evolution Engine E2E 验证与质量评估

**Description:** 手动验证 + LLM Judge 质量评估，需要在真实 pi 环境中运行。

**Tasks:** Task 2, Task 5

**Files (预估):** 2 个文件（2 create）

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | 按 taskComplexity 自动选择 |
| 注入上下文 | Task 描述 + E2E 测试场景 + D3.3 评分标准 |
| 读取文件 | evolution-engine/docs/e2e-test-log.md |
| 修改/创建文件 | evolution-engine/docs/e2e-test-log.md, evolution-engine/docs/d3.3-quality-assessment.md |

**Execution Flow (EG2 内部):** 串行。

  Task 2 (E2E 闭环验证, depends on Task 1):
    1. general-purpose → 安装 extension + 运行 /evolve + apply + rollback + 记录结果

  Task 5 (D3.3 质量评估, depends on Task 3 + Task 4):
    1. general-purpose → 运行 3 个模板的 Judge + 评分 + 记录

**Dependencies:** Task 2 依赖 BG1 Task 1；Task 5 依赖 BG1 Task 3 + Task 4

**设计细节:** E2E 验证需要在真实 pi 环境中执行，不能纯单元测试。D3.3 需要实际 LLM 调用评估质量。

## Dependency Graph & Wave Schedule

```
  Task 1 (BG1: 验证+修复) ──→ Task 2 (EG2: E2E闭环) ──→ Task 3 (BG1: 修复buffer)
                                    │                            │
                                    └────────────────────────────┘
                                                                 │
  Task 4 (BG1: merge-reviewer + 增强) ←──────────────────────────┘
       │
       └──→ Task 5 (EG2: D3.3质量评估)
```

| Wave | Tasks | Group | 说明 |
|------|-------|-------|------|
| Wave 1 | Task 1 | BG1 | 基础验证与接口对齐，无依赖 |
| Wave 2 | Task 2 | EG2 | E2E 闭环验证，依赖 Task 1 |
| Wave 3 | Task 3 | BG1 | E2E 修复 buffer，依赖 Task 2 的发现 |
| Wave 4 | Task 4 | BG1 | merge-reviewer + 增强，依赖 Task 3 |
| Wave 5 | Task 5 | EG2 | D3.3 质量评估，依赖 Task 3 + Task 4 |

---

## ADR Evaluation

扫描 plan 中的新决策：

1. **merge-reviewer target 类型** — 不满足条件（无真实权衡，只是枚举值扩展）
2. **测试路径从硬编码改为动态** — 不满足条件（标准做法）
3. **monitor.ts 引入 shared/logger** — 不满足条件（复用现有模式）
4. **D3.3 门控使用 glm-5.1 模型** — 已在 Phase 3 中决定，非新决策

**结论：无新决策满足 ADR 三条件（难以逆转 + 无上下文会惊讶 + 真实权衡），不创建新 ADR。**
