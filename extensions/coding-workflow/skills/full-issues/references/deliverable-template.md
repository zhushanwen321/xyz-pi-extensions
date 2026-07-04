# 交付物模板：issues.md + issues.html

> 单个 issue 的完整格式见 `issue-template.md`。决策图机制见 `fog-of-war.md`。

## frontmatter

```yaml
---
verdict: pass
upstream: system-architecture.md
downstream: non-functional-design.md
backfed_from:   # 被哪些下游阶段反哺过（如 [④, ⑤]），初始为空
---
```

## 章节结构

```markdown
# Issue 决策图 — {主题}

## 地图总览
（Mermaid graph — 节点=issue，边=blocked_by，状态色标：resolved/investigating/fog）

## 上游覆盖核验（MANDATORY，逐条不漏）
（见下方说明 — 从 system-architecture.md 逐条扫描，每个元素必须有对应 issue 或显式 N/A+理由）

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

## 「上游覆盖核验」章节（MANDATORY）

> **这是「不漏项」的第一道防线——把上游每个元素从沉默变可见。**
> 没有这张表，Step2 独立重建无表可 diff（覆盖关系必须显式声明）。
> 机器检查（CW gate check-issues）只验形式（表存在、每行有 issue 或 N/A+理由），**查不了实质完整**——漏行/虚标/弱理由靠 Step2 独立重建对抗。

按 `fog-of-war.md` 的 4 轴（状态/模块/边界/挑战）从 system-architecture.md 逐条扫描，每个可拆元素填一行：

```markdown
## 上游覆盖核验（MANDATORY，逐条不漏）

| 上游元素 | 轴 | 对应 issue | 状态 | N/A 理由（状态=N/A 时必填）|
|---------|----|-----------|------|---------------------------|
| §5: 状态A→状态B | 状态 | #3 | ✅ 已覆盖 | — |
| §5: 状态B→状态C（异常）| 状态 | #7 | ✅ 已覆盖 | — |
| §5: 状态C→状态D（超时降级）| 状态 | — | N/A | 降级到④非功能设计处理（见下注）|
| §7: {模块名} | 模块 | #1 | ✅ 已覆盖 | — |
| §8: {边界名} | 边界 | #5 | ✅ 已覆盖 | — |
| §10: {挑战名} | 挑战 | #2 | ✅ 已覆盖 | — |
```

**规则：**

1. **每行必须二选一**：要么 `对应 issue` 填 `#{N}`（状态 ✅），要么状态标 `N/A` 且 `N/A 理由` 写一句话。
2. **状态语义**：
   - ✅ 已覆盖 — 有对应 issue
   - N/A — 判定不需要 issue（必须写理由，如「已是稳定模块」「降级到④处理」「被另一 issue 吞并」）
   - ❌ 待补 — 漏了，需补 issue（**不允许留在终稿**——终稿前必须转 ✅ 或 N/A）
3. **N/A 是逃生口，不是摆设**：它强迫 agent 把「不做」articulate 成一句话。这句话随后会被 Step2 重建 subagent 和 Step6 审查质疑「这个 N/A 理由站得住吗？」。**沉默不再是免费的——要么有 issue，要么有一句可被推翻的决策。**
