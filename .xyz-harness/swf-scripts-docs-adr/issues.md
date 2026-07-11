---
verdict: pass
stage: mid-detail-plan
---

# Issues — swf-scripts-docs-adr（T3: 预制脚本 + 文档/ADR）

> 纯文档/脚本主题（refactor 模式）。8 个 issue 按 4 轴扫描推导，无根本性架构分歧（核心决策 D-030~D-033R 已在 mid-plan 确认）。

## 决策图（DAG）

```
#1 examples（4 脚本）  #2 ADR-030  #6 AGENTS.md  #7 ext-deps
  └→ #4 skill-wf         └→ #3 superseded
                           └→ #5 skill-exe     #8 deprecated ← #7
```

- W0（无依赖）：#1, #2, #6, #7 并行
- W1（dep W0）：#3(dep #2), #4(dep #1)
- W2（dep W1）：#5(dep #3), #8(dep #7)

## 上游覆盖核验

| #Issue | 覆盖 UC |
|--------|---------|
| #1 | UC-1, UC-2, UC-3, UC-4 |
| #2 | UC-5 |
| #3 | UC-6 |
| #4 | UC-9 |
| #5 | UC-11 |
| #6 | UC-7 |
| #7 | UC-8 |
| #8 | UC-10 |

## 4 轴扫描结果

| 轴 | 扫描发现 | 对应 Issue |
|----|---------|-----------|
| 状态 | 13 项交付物：4 新建脚本 + 1 新建 ADR + 2 修改 ADR + 2 更新 skill + 2 更新文档/配置 + 2 deprecated 包 | #1~#8 |
| 模块 | examples/ 归属新包；workflow-script-format skill 归属新包；coding-execute skill 跨包（coding-workflow）；ADR 归属 docs/adr/ | #1,#4,#5,#6 |
| 边界 | coding-workflow dependsOn 迁移（pi-workflow→新包）；旧包 deprecated 不影响已安装用户 | #7,#8 |
| 挑战 | lintScript 校验；package.json files 声明；ADR-029 部分 superseded 措辞精确性；workflow() 签名一致性；并发上限来源标注 | #1,#2,#3,#4 |

---

## #1: 预制脚本 4 模板内容设计

**P 级**: P0
**类型**: 模块
**Blocked by**: 无（workflow() 函数已在 T1 实现）
**推荐强度**: Strong

### 问题描述

4 个 .example.js 模板需展示 workflow() 函数的 4 种编排模式（chain/parallel/scatter-gather/map-reduce），作为用户的参考实现。关联 system-architecture §5 预制脚本文件组织。

### 为什么是 P0

预制脚本是 G1 的核心交付物（UC-1~UC-4），workflow() 嵌套编排的主要价值展示。T2 §8 明确移交 T3。

### 方案对比

#### 方案 A: 最小可运行示例（每模板 ~30 行）

**改动**: 每模板只展示核心模式（1 个 workflow() 调用链），省略复杂错误处理。
**优点**: 简洁，用户一眼看懂模式核心。
**缺点**: 缺少生产级错误处理参考，用户需自己补。

#### 方案 B: 完整可用示例（每模板 ~60 行）

**改动**: 每模板含完整 meta 声明 + $ARGS 入参 + 错误处理 + 注释说明分层配额。
**优点**: 用户 copy 后可直接改 workflow 名称运行，错误处理是最佳实践参考。
**缺点**: 文件较长。

### 取舍决策

**选择**: 方案 B（完整可用示例）
**理由**: workflow 嵌套是新能力，用户需要完整的错误处理参考（AC-1.3 要求含错误处理）。注释说明分层配额规则（AC-2.3）。60 行可接受。

### 验收标准

- [ ] AC-1.1 [正常](trace: UC-1 AC-1.1): chain.example.js 含 meta + workflow() + 注释
- [ ] AC-1.2 [正常](trace: UC-1 AC-1.2): 4 脚本通过 lintScript
- [ ] AC-1.3 [边界](trace: UC-1 AC-1.3): 每脚本含 try-catch 错误处理
- [ ] AC-1.4 [边界]: package.json files 字段含 examples/

---

## #2: ADR-030 合并架构决策记录

**P 级**: P0
**类型**: 流程
**Blocked by**: 无
**推荐强度**: Strong

### 问题描述

ADR-030 记录三主题合并的 4 项核心决策 + 承接 ADR-026 L3A 立场。关联 system-architecture §5 ADR 架构。

### 为什么是 P0

ADR-030 是所有 superseded 标记的前置（#3 blocked_by #2）。G2 核心交付物。

### 方案对比

#### 方案 A: 单 ADR-030 全覆盖

4 项决策（合并/执行链/配额嵌套/删sync通知）+ L3A 承接，全部在 ADR-030。

#### 方案 B: 拆分多 ADR（030 合并 + 031 执行链 + 032 配额）

每个核心决策独立 ADR。

### 取舍决策

**选择**: 方案 A（单 ADR-030）
**理由**: 4 项决策是同一个合并行动的不可分割面（合并为一包才有统一执行链，才有配额嵌套，才有删sync）。拆分会让 ADR 间互相引用复杂化。ADR-026 也是单 ADR 记录多决策的先例。

### 验收标准

- [ ] AC-2.1 [正常](trace: UC-5 AC-5.1): ADR-030 含 Status/Context/Decision/Consequences
- [ ] AC-2.2 [正常](trace: UC-5 AC-5.2): Decision 含 4 项核心决策
- [ ] AC-2.3 [正常](trace: UC-5 AC-5.3): 引用 ADR-026/029 为前置决策
- [ ] AC-2.4 [边界]: 并发上限标注来源（T2 system-architecture §并发池分层配额）

---

## #3: ADR-026/029 superseded 标记

**P 级**: P0
**类型**: 流程
**Blocked by**: #2
**推荐强度**: Strong

### 问题描述

ADR-026 完全 superseded；ADR-029 部分 superseded（D-033R：仅 worktree 编排决策 2 被取代）。

### 方案对比

#### 方案 A: Status 行 + Superseded 说明段

在 ADR-026/029 顶部改 Status，添加「Superseded by ADR-030」说明段，保留原文不动。

#### 方案 B: 重写 ADR-026/029 内容

用新架构覆盖旧内容。

### 取舍决策

**选择**: 方案 A（Status 行 + 说明段）
**理由**: ADR 是 append-only 历史记录，保留原文保证可追溯性。superseded 只改 Status + 加说明。ADR-029 部分 superseded 需精确列出哪些决策被取代（决策 2 worktree 编排）、哪些仍有效（决策 1 per-call cwd + 决策 3 cw调用 + 决策 4 plan.json schema + 决策 5 砍 pending-env + 决策 6 store WAL，均与合并正交）。

### 验收标准

- [ ] AC-3.1 [正常](trace: UC-6 AC-6.1): ADR-026 Status = "Superseded by ADR-030"
- [ ] AC-3.2 [正常](trace: UC-6 AC-6.2): ADR-029 Status = "Partially superseded by ADR-030"
- [ ] AC-3.3 [边界]: ADR-029 说明段逐决策标注被取代/仍有效

---

## #4: workflow-script-format skill 更新

**P 级**: P1
**类型**: 模块
**Blocked by**: #1
**推荐强度**: Strong

### 问题描述

skill 文档新增 workflow() 函数 API + 更新 parallel() 上限 4→6 + chain/parallel 基础示例。

### 方案对比

#### 方案 A: 新增独立 workflow() 文档段 + 基础示例

**改动**: skill 文档新增 workflow() 函数说明段 + parallel() 上限改 6 + chain/parallel 简洁示例
**优点**: 与 examples/ 分工清晰（skill 教 API，examples 教模式），用户查阅 skill 即知用法
**缺点**: 需同时改 parallel() 上限文字（4→6），稍增改动范围

#### 方案 B: 只更新 parallel() 上限，workflow() 留给 examples/ 自学

**改动**: 只改 parallel() 上限 4→6，不加 workflow() 文档段
**优点**: 最小改动
**缺点**: workflow() 是新能力，用户不查 skill 就不知道用法，门槛高

### 取舍决策

**选择**: 方案 A
**理由**: G4 目标明确要求 skill 文档含 workflow()。skill 示例简洁教 API 用法，与 examples/ 完整脚本分工（D-031）。parallel() 上限 6 来源 T2。

### 验收标准

- [ ] AC-4.1 [正常](trace: UC-9 AC-9.1): SKILL.md 含 workflow() 函数说明
- [ ] AC-4.2 [正常](trace: UC-9 AC-9.2): parallel() 上限改为 6
- [ ] AC-4.3 [正常](trace: UC-9 AC-9.3): 含 chain/parallel 基础示例

---

## #5: coding-execute skill worktree 编排更新

**P 级**: P1
**类型**: 模块
**Blocked by**: #3
**推荐强度**: Strong

### 问题描述

ADR-029 决策 2（worktree 编排：4 phase + git worktree add/remove）转移到 coding-execute skill，D-033R 要求。

### 方案对比

#### 方案 A: 转移到 coding-execute skill

**改动**: coding-execute SKILL.md 新增 worktree 编排段（4 phase + git worktree add/remove）
**优点**: worktree 编排知识在 skill 中持续可查，ADR-029 superseded 后不丢失
**缺点**: 跨包编辑（coding-workflow 包）

#### 方案 B: 保留在 ADR-029 原文不转移

**改动**: ADR-029 只改 Status 不转移内容
**优点**: 零额外工作
**缺点**: 知识封存在已标 superseded 的 ADR 中，用户不会查阅，等于丢失

### 取舍决策

**选择**: 方案 A
**理由**: D-033R 明确要求转移。内容来自 ADR-029 决策 2 原文，不丢失 worktree 编排知识。

### 验收标准

- [ ] AC-5.1 [正常](trace: UC-11 AC-11.1): coding-execute SKILL.md 含 worktree 编排说明
- [ ] AC-5.2 [正常](trace: UC-11 AC-11.2): 内容来自 ADR-029 决策 2

---

## #6: AGENTS.md/CLAUDE.md 目录更新

**P 级**: P1
**类型**: 流程
**Blocked by**: 无
**推荐强度**: Strong

### 问题描述

AGENTS.md 目录树 + 包清单表新增 subagents-workflow；关键约束段「两个 spawn 例外」改为单包单执行链描述。

### 方案对比

#### 方案 A: 目录树 + 包清单表 + 关键约束段

**改动**: 三处同步更新（目录树加新包条目、包清单表加行、关键约束段改单包单执行链）
**优点**: 全量同步，check-structure 通过，AI 定位不失败
**缺点**: 改动点较多

#### 方案 B: 只更新目录树

**改动**: 只在目录树加 subagents-workflow 条目
**优点**: 最小改动
**缺点**: 包清单表和关键约束段过时，check-structure 可能报同步不一致

### 取舍决策

**选择**: 方案 A
**理由**: G3.1 明确要求全量同步。check-structure 机器校验兼底。

### 验收标准

- [ ] AC-6.1 [正常](trace: UC-7 AC-7.1): 目录树含 subagents-workflow
- [ ] AC-6.2 [正常](trace: UC-7 AC-7.2): 包清单表含新包
- [ ] AC-6.3 [边界](trace: UC-7 AC-7.3): check-structure 通过

---

## #7: extension-dependencies.json 旧包标注 superseded（T1 #6 负责新包条目+迁移）

**P 级**: P1
**类型**: 边界
**Blocked by**: 无（T1 #6 已先于 T3 完成）
**推荐强度**: Strong

### 方案对比

#### 方案 A: T3 仅负责旧包 superseded 标注 + 验证 T1 #6 产出

**改动**: 旧两包条目加 `supersededBy` 标注指向新包；验证 T1 #6 已新增 subagents-workflow 条目 + coding-workflow 迁移
**优点**: 无重复归属——T1 #6 负责「新包诞生」（条目+依赖+迁移），T3 #7 负责「旧包退休」（superseded 标注）
**缺点**: 跨主题协作——T3 需验证 T1 #6 产出而非自己创建

### 取舍决策

**选择**: 方案 A
**理由**: T1→T2→T3 执行序保证 T1 #6 先完成新包条目+迁移。T3 #7 仅做旧包退休标注（与 T3 deprecated 主题一致），消除与 T1 #6 的 AC 重叠。

### 验收标准

- [ ] AC-7.1 [正常](trace: UC-8 AC-8.4): 旧两包条目标注 `supersededBy: "@zhushanwen/pi-subagents-workflow"`（T1 #6 不涉及旧包标注）
- [ ] AC-7.2 [边界]: 验证 T1 #6 产出存在——新包条目 + coding-workflow dependsOn 迁移仍合法
- [ ] AC-7.3 [正常]: `npx ajv-cli validate` 通过（含旧包标注后整体合法）

---

## #8: 旧包 deprecated + CHANGELOG

**P 级**: P2
**类型**: 流程
**Blocked by**: #7
**推荐强度**: Strong

### 问题描述

旧两包 package.json + CHANGELOG deprecated 标记。

### 取舍决策

**选择**: 直接执行
**理由**: G5 明确。D-004 旧包不动代码，只标记 deprecated。

### 验收标准

- [ ] AC-8.1 [正常](trace: UC-10 AC-10.1): package.json 含 deprecated 字段
- [ ] AC-8.2 [正常](trace: UC-10 AC-10.2): deprecated 消息含迁移路径
- [ ] AC-8.3 [边界](trace: UC-10 AC-10.3): CHANGELOG 含迁移说明
- [ ] AC-8.4 [边界](trace: UC-8 AC-8.4): 验证 #7 已完成旧两包 ext-deps superseded 标注（本 AC 验收 #7 产出）

---

## P3 延后项

无。T3 是三主题收尾，所有交付物在本次完成。
