# 交付物模板：issues.md + issues.html

> 单个 issue 的完整格式见 `issue-template.md`。决策图机制见 `fog-of-war.md`。

## frontmatter

```yaml
---
verdict: pass
upstream: system-architecture.md
downstream: non-functional-design.md
---
```

## 章节结构

```markdown
# Issue 决策图 — {主题}

## 地图总览
（Mermaid graph — 节点=issue，边=blocked_by，状态色标：resolved/investigating/fog）

## P0 Issues（阻塞项，必须先做）
### #1: {标题} — 按 issue-template.md 完整格式

## P1 Issues（核心）
### #3: {标题}

## P2 Issues（重要）
### #6: {标题}

## 迷雾（未展开）
### #8: {可能的 issue} ?

## 后续迭代（P3 延后项）
- #10 [P3]: {延后项} — 延后理由
```

P 级定义（MoSCoW）与取舍原则详见 `issue-template.md`。
