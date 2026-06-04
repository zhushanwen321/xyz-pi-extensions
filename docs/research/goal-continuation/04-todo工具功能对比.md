# Todo 工具功能对比 — Pi todo vs Codex update_plan

## 数据模型对比

| 方面 | Pi todo | Codex update_plan |
|---|---|---|
| **操作模式** | 增量 CRUD（add/update/delete/clear/list） | 全量快照替换（每次传完整 plan） |
| **数据结构** | 独立 Todo 对象，id+text+status | PlanItemArg 数组，step+status |
| **状态枚举** | pending / in_progress / completed | pending / in_progress / completed |
| **说明字段** | 无 | explanation（optional） |
| **约束规则** | 同一时间最多一个 in_progress | 同一时间最多一个 in_progress |
| **跳过限制** | 无显式限制 | 不能从 pending 跳到 completed |

## 实现差异

### Pi todo — 增量 CRUD 模式

```typescript
// 每个 action 是独立的 API 调用
todo.add({ texts: ["步骤1", "步骤2"] })          // 批量添加，自动分配 id
todo.update({ id: 1, status: "completed" })      // 按 id 更新
todo.update({ id: 2, text: "新文本" })            // 可只改文本不改状态
todo.delete({ ids: [1, 2] })                      // 批量删除
todo.clear({})                                     // 清空所有
todo.list({})                                      // 查看全部
```

**关键设计**：
- `reconstructState` 从 session entry 的 tool result details 重建状态（跨 turn 记忆）
- `before_agent_start` 中检查自动清空（全部完成 2 轮后）和任务提醒
- TUI 集成：`/todos` 命令打开交互式组件

### Codex update_plan — 全量快照模式

```rust
// 每次调用必须传入完整 plan 数组
update_plan({
  explanation: "完成步骤1，开始步骤2",
  plan: [
    { step: "分析需求", status: "completed" },
    { step: "编写代码", status: "in_progress" },
    { step: "测试验证", status: "pending" },
  ]
})
```

**关键设计**：
- 无持久化，仅通过 EventMsg::PlanUpdate 推送到 UI
- 不在 Plan mode 下使用（Plan mode 有独立的计划工具）
- Prompt 要求：之前步骤全部 completed 后才能完成整个 plan
- "不要重复 plan 内容——CLI 已经显示了"

## 使用体验差异

| 场景 | Pi todo | Codex update_plan |
|---|---|---|
| **新增任务** | `add({texts:["新步骤"]})` 增量添加 | 必须传包含新步骤的完整 plan |
| **完成第一步** | `update({id:1, status:"completed"})` | 传整个 plan，改第一步为 completed |
| **删除任务** | `delete({ids:[3]})` | 从 plan 数组中移除 |
| **查看清单** | `list()` → 返回当前列表 | `get_goal` 只能看 goal，plan 无查询 |
| **恢复状态** | reconstructState 重新读取 | 无状态可恢复（瞬态） |

## 定位差异

```
Pi todo: "轻量级任务追踪"
  - 适合 3-8 个步骤的短期任务
  - 支持生命周期管理（自动清空、任务提醒）
  - 与 goal_manager 定位严格分离

Codex update_plan: "步骤可见性"
  - 重点是"让用户看到进度"，不是任务管理
  - 不持久化、不跨 turn
  - 与 Plan mode 严格分离
```

## 共存情况

### Pi 中的 todo 与 goal_manager

```typescript
// todo 的 promptGuidelines 明确说明：
"[定位] 不要用 todo 替代 goal_manager，两者定位不同"
"[使用场景] 多步骤任务（3+步）、需要追踪进度时"
"[不适用] 已在用 goal_manager 时"
```

**Pi 的策略**：互斥使用。在 goal_manager 模式下，subtask 替代 todo。

### Codex 中的 update_plan 与 Thread Goal

Codex 没有明确禁止同时使用，但两个工具的定位完全不同：
- `update_plan`：**当前 turn 的步骤清单**，模型用来展示进度
- `create_goal`/`update_goal`：**跨 turn 的目标管理**，系统用来控制生命周期

**Coexistence**：一个 turn 内模型可以同时调用 update_plan（展示当前步骤）和管理 goal（标记完成/阻塞）。
