# Pi 与 Codex Todo/Goal 功能对比 — 概览

## 对比总表

| 维度 | Pi todo | Pi goal_manager | Codex update_plan | Codex Thread Goal |
|---|---|---|---|---|
| **本质** | 轻量级任务清单 | 结构化目标管理框架 | 步骤式 TODO 清单 | 持久化目标自动推进系统 |
| **启动方式** | 模型主动使用 | 用户通过 `/goal` 触发 | 模型主动使用 | 用户或模型通过 `create_goal` 触发 |
| **持久化** | session entry 重建 | session entry 持久化 | 事件流（非持久） | SQLite 持久化 |
| **跨 TURN 支持** | 跨 turn 记忆（reconstructState） | 跨 turn 自动 continuation | 本 turn 内有效 | 系统级 auto-continuation |
| **Budget 管理** | 无 | Token + 时间 + 轮次上限 | 无 | Token budget + 会计 |
| **状态机** | pending/in_progress/completed | 7 种状态，含 blocked/cancelled | pending/in_progress/completed | 6 种系统级状态 |
| **证据要求** | 无 | completed 必须带 evidence | 无 | prompt 内要求 verification audit |
| **UI 集成** | TUI widget + status bar | TUI widget + status bar | 事件推送到 CLI | 事件推送到 CLI |
| **粒度** | 单项/批量 add/update/delete | task 列表 + subtask | 快照式全量 plan | 单目标（thread 内唯一） |

## 核心哲学差异

```
Pi 哲学：AI 辅助用户完成任务
  → 模型是执行者，用户是决策者
  → 结构化的任务分解 + 强制验证门禁
  → 证据驱动完成

Codex 哲学：AI 自主完成任务
  → 模型是执行者+规划者
  → 跨 turn 自主持续工作，系统负责续跑
  → 预算自动管理 + 系统级 steering
```

> ⚠️ **注意**：两者在核心能力上实际高度重合。Pi goal extension 同样具备跨 turn continuation、
> token 会计、预算管理、stall 检测、自动阻塞等

## 四个工具的定位层次

```
轻量 TODO                         重型目标管理
   <───────────────────────────────────────>
   Pi todo              Pi goal_manager
   Codex update_plan    Codex Thread Goal

Pi todo ≈ Codex update_plan    (同等层次)
Pi goal_manager ≠ Codex Thread Goal  (完全不同的设计)
```

## 关键差异摘要

1. **任务分解机制是最大差异**。Pi 强制模型调用 `create_tasks` 将目标拆为可验证的 task，每项需独立 evidence；Codex 只有 objective，模型自行规划。

2. **验证在工具层 vs Prompt 层**。Pi 在代码层强制 evidence 参数（不传就抛异常），Codex 在 prompt 指令层要求 completion audit（违反不会报错）。

3. **Continuation 机制不同**。Pi 通过 `sendUserMessage`（用户可见、需 approval），Codex 通过内核 `start_task`（系统级、隐式新 turn）。

4. **状态控制权不同**。Pi 允许模型 `cancel_goal` 取消目标，Codex 不允许模型放弃——只能 `complete` 或 `blocked`。

5. **Pi 有时间预算 + 上下文保护**（85% 自动暂停），Codex 没有。
