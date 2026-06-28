---
name: lite-retrospect
description: >-
  Use when the user says "轻量复盘", "lite retrospect", "做个复盘", "复盘一下",
  or after a lite-execute run has completed (goal completed) and wants a quick
  self-check retrospect on the dev/test process, docs, skill/subagent quality,
  prompt tuning, and architecture signals. Produces a lightweight checklist
  report (not a deep evidence extraction). Not for design closeout (that is
  design-closeout). Not for planning or execution.
---

# 轻量复盘（Lite Retrospect）

## 核心目标

在一次 lite 工作流（lite-plan → lite-execute）跑完后，用**轻量自检清单**快速复盘：哪里顺、哪里卡、有什么可改进。不追求结构化证据提取，追求**快速发现问题 + 一句话改进建议**。

> **定位：轻量。** 不是 design-closeout（沉淀长期文档），不是 harness-retrospect（重流程质量复盘）。是一张 5 分钟过完的清单，帮下次跑得更好。

## 前置

- lite-execute 已完成（goal 已 complete，验收全绿）
- 可选：plan.md + 测试报告仍在（便于回顾）

## 流程

单一意图（复盘）：过自检清单 → 写报告 → 交付。三步线性推进。

### Step 1. 过自检清单

逐项自检，标记 ✅（好）/ ⚠️（需注意）/ ❌（有问题），❌ 和 ⚠️ 附一句话改进建议。

#### 流程自检

- [ ] plan 的 Wave 拆分是否准确？有无返工源于拆分不当（如漏了文件依赖、并行组划错）
- [ ] TDD 是否真执行（每个 implementer 先写测试再实现）？还是出现"先写代码后补测试"
- [ ] 失败循环触发了几轮？哪轮最耗时？是测试设计问题还是实现问题
- [ ] 测试 ‖ review 并行是否真并行了？有无不必要的串行（如 worktree 没建好导致串行跑）

#### 测试质量自检

- [ ] 覆盖率是否达标（≥60%）？哪部分增量未覆盖（关键逻辑还是边缘分支）
- [ ] E2E 边界用例是否漏了关键场景？有无 bug 是测试没覆盖、验收时才暴露
- [ ] plan 的测试清单与实际跑的测试是否一致？有无用例被静默跳过

#### 文档自检

- [ ] plan.md 是否与最终实现一致？有无偏差（实现改了 plan 没更新）
- [ ] 是否需要更新 CLAUDE.md / ARCHITECTURE.md / 相关 ADR（本次改动有无影响约定/架构）
- [ ] 测试清单是否值得沉淀进 TEST-STRATEGY.md（如有破坏即事故的基线用例）

#### skill / subagent 优化自检

- [ ] lite-plan / lite-execute 的指令是否有歧义导致 AI 跑偏？哪步最模糊
- [ ] implementer / test-runner / code-review subagent 的 prompt 和 context 是否足够？有无 NEEDS_CONTEXT / BLOCKED
- [ ] subagent 工具白名单是否过严（该有的工具没有）或过松（不该有的给了）

#### 系统提示词 / 业务 / 架构自检

- [ ] 是否有反复出现的错误，提示了 CLAUDE.md 或系统提示词需要补充某条规则
- [ ] 业务流程是否合理？有无可简化的环节（如某个 Wave 其实可合并、某步验证多余）
- [ ] 是否暴露了架构层面的问题（如某模块耦合太紧导致 Wave 无法并行 → 需 design 重构）

### Step 2. 写复盘报告

把清单结果写入 `.xyz-harness/{yyyy-MM-dd}-lite-{topic}/retrospect.md`：

```markdown
# Lite 复盘：{topic}（{date}）

## 概况
- Wave 数：{N} | 失败循环轮数：{R} | 覆盖率：{X}%
- 总体：✅ 顺利 / ⚠️ 有改进点 / ❌ 有问题

## 清单结果

### 流程
- ✅ Wave 拆分准确
- ❌ TDD 第 2 个 Wave 跳过了先写测试 → 改进：implementer prompt 强调"跑确认失败"步骤
...

### 测试质量
...

### 文档
...

### skill/subagent
...

### 提示词/业务/架构
...

## 改进项（按优先级）
1. [P0] <最该改的，一句话>
2. [P1] <次要>
3. [P2] <可选>
```

> 轻量：不进长期文档（那是 design-closeout 的活），不强制 action item 落地。只是记录 + 提示。

### Step 3. 交付

```
✅ 复盘完成：.xyz-harness/{date}-lite-{topic}/retrospect.md
   概况：{N} Wave，{R} 轮失败循环，覆盖率 {X}%
   改进项：{P0 数} 个 P0 / {P1 数} 个 P1
   最值得改：<P0 第一条>
```

## 何时升级

复盘若发现**架构层面的反复问题**（如模块耦合导致并行受限、测试总在某层断裂），建议：
- 走 design 工作流做一次架构设计（design-init → design-architecture）
- 或更新对应 ADR 记录架构决策

> lite 复盘的价值之一：发现"小功能也卡"的根因往往是架构债，这时该升级到 design。

## 标记说明

| 标记 | 含义 |
|------|------|
| ✅ | 做得好，保持 |
| ⚠️ | 需注意，有改进空间 |
| ❌ | 有问题，应改进 |
