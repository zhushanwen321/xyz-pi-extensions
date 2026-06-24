# 交付物模板：execution-plan.md + execution-plan.html

> execution-plan.md 的章节结构模板。本文件是格式起点，具体内容由 shared-loop 的 Step 1-5 产出。
> 单 Wave 模板见 `wave-template.md`。垂直切片机制见 `vertical-slice.md`。
> 渲染 HTML 的规范见 `skills/xyz-harness-design-clarity/references/visual-deliverable.md`。

## frontmatter

```yaml
---
verdict: pass
upstream: code-architecture.md
downstream: coding
---
```

## 章节结构

```markdown
# 执行计划 — {主题}

## Wave 编排总览

### 依赖 DAG 图
（Mermaid graph — Wave 节点 + blocked_by 边）

### 调度表
| Wave | 切片 | P级 | Blocked by | 并行组 | 说明 |
|------|------|-----|-----------|--------|------|

### 并行约束
- 同组最多 3 个 subagent 并行
- 同文件不允许多 Wave 同时修改
- 前端 Wave 需对应后端 API 就绪

## Wave 详情

### Wave 0: {prefactor 或首个切片}
（按 wave-template.md 单 Wave 模板）

### Wave 1: {垂直切片}
...

## 后续迭代（P3 延后项）
- Issue #{N} [P3]: {延后项} — 延后理由

## 执行交接

本计划完成后，进入编码实现：
- 如使用 coding-workflow：启动 Phase 流程（spec→plan→dev→test→pr）
- 如手动执行：每个 Wave 派一个 subagent，按 Wave 内执行流走 TDD 链
```
