---
name: code-review-worktree
description: >-
  Use when the user says "code review", "review code", "审查代码", "帮我 review",
  "review changes", "check code quality", "看看代码质量", or wants a multi-dimensional
  review of worktree/branch changes. Not for single-file edits or non-code changes.
  Not for single-dimension review — dispatch the specific review agent directly.
---

# Code Review Worktree

多维度并行代码审查。自动检测 harness/standalone 模式，按 effort 策略分派 agent 或主会话直接审查。

## When to Use

- 多文件变更需要系统性审查
- 想要同时覆盖健壮性、品味、规范、架构等维度

## When NOT to Use

- 单文件小改动 → 主 agent 直接看
- 只需单维度深度审查（如只查品味）→ 直接分派 `review-taste`
- 非 code 变更（文档、配置）→ 不适用
- 在 coding-workflow Phase 3 内 → 已有内置审查流程

## 模式与维度

| 维度 | Agent | harness | standalone | spec/plan 依赖 |
|------|-------|:-------:|:----------:|:--------------:|
| BLR | `review-blr` | ✅ | — | 需 spec.md |
| Standards | `review-standards` | ✅ | ✅ | 无 |
| Taste | `review-taste` | ✅ | ✅ | 无 |
| Robustness | `review-robustness` | ✅ | ✅ | 无 |
| Integration | `review-integration` | ✅ | — | 需 BLR 产出 |
| Architecture | `review-architecture` | — | ✅ | 无 |
| Data-Flow | `review-dataflow` | — | ⚡ | 无 |

触发条件：harness = `.xyz-harness/` 存在且含 spec.md + plan.md；否则 standalone。⚡ = dataflow_signals=detected 时启用。

## 操作流程

### Step 1: 收集上下文

```bash
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
bash "${SKILL_DIR}/review-context.sh"
```

脚本输出 JSON。关键字段：`harness_mode`、`effort`、`dimensions`、`primary_lang`、`files`、`dataflow_signals`。

**`harness_mode: "none"`**：无变更文件，直接告诉用户"没有发现需要审查的变更"并结束。

脚本不可用时手动收集等价信息：

```bash
git diff main...HEAD --stat && git diff main...HEAD --name-only
ls .xyz-harness/ 2>/dev/null
```

### Step 2: 报告 + 策略

向用户说明模式、变更规模、将启用的维度。按 effort 决定策略：

| effort | 条件 | 策略 |
|--------|------|------|
| simple | ≤3 文件, ≤100 行变更 | 主会话串行审查所有维度 |
| medium | ≤10 文件, ≤500 行 | 按 Batch 分派 agent（并发 ≤3） |
| complex | 超过 medium | 同 medium + 按文件分组 |

**harness 编排**（Batch 间有依赖）：
```
Batch 1 (≤3): review-blr, review-standards, review-taste
Batch 1 续:   review-robustness
Batch 2:      review-integration（串行，等 BLR 完成）
```

**standalone 编排**：
```
Batch 1 (≤3): review-robustness, review-taste, review-standards
Batch 1 续:   review-architecture
Batch 2:      review-dataflow（仅 dataflow_signals=detected 时）
```

### Step 3: 分派 Agent / 直接审查

**分派模板**：
```
agent: "review-{dimension}"
cwd: {项目根目录}
task: |
  变更文件: {files}
  获取 diff: 在 {cwd} 下执行 git diff {against}...HEAD -- {files}
  输出到: {output_path}
  {维度特有参数}
```

维度特有参数：

| Agent | 额外参数 |
|-------|---------|
| review-blr | `spec_path: {harness_dir}/spec.md` |
| review-standards | `claude_md_path: {cwd}/CLAUDE.md`（可选） |
| review-taste | `lang: {primary_lang}`（可选） |
| review-integration | `blr_result_path: {output}/business_logic_review_v1.md` |
| review-dataflow | `signals: {dataflow_signals}` |

**simple 模式**：不分派 agent，主会话按维度顺序串行审查，每个维度独立输出问题清单。

### Step 4: 汇总

从所有结果提取问题，按优先级汇总：

```markdown
# Code Review Report

## 概要
- 审查范围: {N} 文件, {+} insertions, {-} deletions
- 审查模式: {harness | standalone}
- 审查维度: {维度列表}

## 问题清单

| # | 优先级 | 维度 | 文件:行号 | 描述 | 修复方向 |
|---|--------|------|-----------|------|---------|

## 统计
- MUST_FIX: {n} | LOW: {n} | INFO: {n}
```

MUST_FIX > 0 → 进入修复流程。全部 INFO → 询问用户。

### Step 5: 修复 + 验证

用户确认后，按文件分组修复（每组 ≤5 文件、1000 行）。只修清单中的问题，不做额外重构——修改清单外代码会引入新问题且需要重新审查。

修复完成后验证：

```bash
npx eslint --max-warnings=0 <modified-files>
npm test 2>&1 | tail -20
```

## 优先级定义

统一使用三级体系（与所有 review agent 输出一致）：

| 优先级 | 含义 | 典型场景 |
|--------|------|---------|
| **MUST_FIX** | 必须修复，阻塞交付 | 数据丢失、功能失效、语义错误、时序错误、lint 报错 |
| **LOW** | 建议修复 | 命名、注释、风格、预存问题 |
| **INFO** | 观察记录 | 无需操作 |

## 输出路径

| 模式 | 路径 |
|------|------|
| harness | `{harness_dir}/changes/reviews/{dimension}_review_v{N}.md` |
| standalone | `{dimension}_review_v{N}.md`（当前目录或用户指定路径） |

## Common Mistakes

| 错误 | 后果 | 正确做法 |
|------|------|---------|
| Integration 不等 BLR 就分派 | Integration 无法消费模拟数据，审查结论不可靠 | 严格按 Batch 顺序：BLR → Integration |
| simple 任务分派 agent | agent 调度开销 > 审查本身 | 主会话直接执行 |
| 修改清单外的代码 | 引入新问题，违反 scope，需要重新审查 | 只修清单中的问题 |
| 跳过 review-context.sh | 缺少模式检测和维度列表，后续分派无依据 → 维度遗漏或编排错误 | Step 1 不可跳过 |
| standalone 遗漏 Standards | lint/typecheck 问题未被发现 | standalone 必须包含 5 维度（含 Standards） |
