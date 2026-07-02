---
phase: issues
adversary_round: 2
frame: dependency-choreography
verdict: MAJOR
---
# 对抗审查 R2 — 依赖编排

> 站在「把 12 issue 排成可执行 Wave 的项目经理」立场，戳 P 级/blocked_by 依赖图能否真调度。
> 审查 agent 只读，本报告由主 agent 据其返回内容落盘。

## 依赖 DAG 分析

### 声明的 blocked_by 图（拓扑有效——无循环）
```
#1 ─┬─► #2 ─┬─► #5 ─┬─► #7 ─► #9 (P2)
    │       │      ╰─► #10 (P2)
    │       ╰─► #12
    ├─► #3 ─► #6 ─┬─► #7
    │             ╰─► #12
    ├─► #4 ─┬─► #7
    │       ╰─► #9
    │       ╰─► #12
    ├─► #5 ─► #10, #12
    ├─► #7 ─► #9, #12
    ├─► #8 (P2 leaf)
    ╰─► #11 (P2 leaf)
```
拓扑检查无循环。P0 #1 零依赖；P0 从不依赖 P1/P2。

### 隐藏的运行时循环（真问题）
#12 同时打包了 **生产者**（alive-store.ts，仅依赖 #1 类型）和 **协调点修改**（record-store 四分支）。但 #4/#6/#7 在运行时**调用** #12 的 alive-store 函数，而 #12 却 blocked_by #4/#6/#7：

| 运行时边 | 消费者 | 所有者 | 声明方向 | 循环？ |
|---|---|---|---|---|
| readAliveMarker+isProcessAlive in scan (AC-4.4/D-024) | #4 WorktreeManager.scan | #12 alive-store | #12 blocked_by #4 | **循环 #4↔#12** |
| writeAliveMarker after session create (AC-6.7) | #6 session-runner.run | #12 alive-store | #12 blocked_by #6 | **循环 #6↔#12** |
| removeAliveMarker in finalizeRecord/cancel (AC-7.8) | #7 SubagentService | #12 alive-store | #12 blocked_by #7 | **循环 #7↔#12** |
| readAliveMarker+isProcessAlive in GC (AC-10.2) | #10 session-file-gc | #12 alive-store | #10 **未** blocked_by #12 | **隐藏依赖**（缺边）|

### 缺失依赖边
- **#10 → #12 缺失**：AC-10.2 调 #12 函数，#10 只声明 blocked_by #1,#5。
- **#9 → #12 传递间接**：AC-9.4 验 D-024 安全网（#12 逻辑），经 #4 传递。

## Wave 编排尝试（用声明图）

| Wave | Issues |
|---|---|
| W1 | #1 |
| W2 | #2, #3, #4, #8, #11 |
| W3 | #5, #6, #10 |
| W4 | #7（汇合 #2,#4,#5,#6）|
| W5 | #9, #12 |

**关键路径 = 5**（#1→#3→#6→#7→#12 或 #1→#2→#5→#7→#12）。**#12 被迫 W5**——标 P1 但调度可达性是 P3（最后交付）。跨实例正确性修复（§5 主要已知盲区）反而最后到。

## 发现

| # | 问题 | 严重度 | 说明 |
|---|------|--------|------|
| 1-3 | 运行时循环 #4↔#12 / #6↔#12 / #7↔#12 | **BLOCKING**（调度层）| #4/#6/#7 消费 #12 函数却声明在 #12 之前；编译/集成测试需 stub。最坏：#4 reaper 在 #12 前发布 → 退化或不安全（删跨实例活 worktree）|
| 4 | #12 汇合 5 P1 deps，W5 关卡 | MAJOR | 标 P1 但可达性 P3；主要并发正确性修复最后到 |
| 5 | #10 缺 blocked_by #12 | MAJOR | AC-10.2 调 #12 函数，图低估；可排 #12 前 Wave 发坏 GC |
| 6 | #9 缺 blocked_by #12（传递）| MINOR | 经 #4 间接 |
| 7 | #12 生产者/消费者折叠 | BLOCKING | alive-store（生产者）+ record-store 扩展（修改）在一个 issue 迫使循环 |
| 8 | #2 最终形态被 #12 延迟 | MINOR | record-store.ts 被触及两次（W2 + W5）|

## 阻断判定
**MAJOR**——声明 DAG 拓扑有效（无死锁），但**声明依赖顺序与运行时调用方向矛盾**（3 对循环），#4/#6/#7 无法对 #12 函数编译/集成测试却排在它之前。

**推荐修复（打破循环 + 缩关键路径）**：拆 #12 → 新 Wave-2 issue **#13 alive-store.ts**（仅生产者，~40 LOC，blocked_by #1）+ #12 收缩为「record-store 四分支 + pid 复用 + externalInstance」（blocked_by {#2,#5}，依赖 5→2）。3 循环全消；#4/#6/#7/#10 干净 blocked_by #13；关键路径缩短；#12 移 W4（与 #7 同，不再滞后）。
