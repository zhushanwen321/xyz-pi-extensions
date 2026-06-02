# Todo Extension v2 Plan

## 目标

升级 Pi 的 todo extension，参考业界最佳实践（Ona、Claude Code Tasks），提升可用性和健壮性。

## 改动范围

单文件：`/Users/zhushanwen/Code/xyz-pi-extensions/todo/src/index.ts`

## 任务清单

### T1. 数据模型升级：boolean → 三态

- `interface Todo` 的 `done: boolean` → `status: "pending" | "in_progress" | "completed"`
- `in_progress` 非强制，`pending → completed` 直接跳转是合法路径
- `reconstructState` 向后兼容：检测旧格式 `done` 字段，转换为 `status`
- `TodoDetails` 的 `todos` 字段同步更新
- 旧 entry 中 `action: "toggle"` 在 `renderResult` 中需要兜底处理（不会崩，但要覆盖到）

### T2. action 调整

**delete**：新增
- 参数：`id`（必需）
- 行为：删除单个 todo，返回剩余数量
- `nextId` 不重置（ID 唯一性 > 连续性），只有 `clear` 才重置

**toggle → update**：替换
- 参数：`id`（必需）+ `status?` + `text?`
- 至少需要 `status` 或 `text` 之一，否则报错
- 参数守卫：
  ```
  update(id: 3)           → 报错：至少需要 status 或 text
  update(status: "done")  → 报错：缺少 id
  update(id: 3, text: "") → 报错：text 不能为空字符串
  ```
- `status` 值校验：只接受 `"pending" | "in_progress" | "completed"`

**保留**：`list`、`add`、`clear` 不变

**action 列表最终版**：`list | add | update | delete | clear`

### T3. Status Line

- 使用 `ctx.ui.setStatus("todo", ...)` 在 footer 显示
- 规则：
  - 有 pending → `☑ 2/5`
  - 全部 completed → `✓ 5/5`（保留，不立即清除）
  - 调用 `clear` 后 → 清除 status line
  - 新增 todo 后自然过渡
- 更新时机：每次 tool execute 结束时调用 `updateStatusLine(ctx)`
- 在 `session_start` 时也调用一次（reconstruct 后）
- 封装为 `updateStatusLine(ctx: ExtensionContext)` 辅助函数

### T4. promptSnippet + promptGuidelines

- `promptSnippet`："轻量级任务清单。多步骤工作时追踪进度，不必等 /goal 模式"
- `promptGuidelines`：
  - 什么时候用 todo：多步骤任务、需要追踪进度、临时记录待办
  - 什么时候不用：单步操作、已经在用 goal_manager
  - 开始工作前主动创建，完成时及时标记
  - 一个 todo 对应一个可验证的工作单元
  - `in_progress` 非强制，`pending → completed` 直接跳转合法
  - 不要过度拆分，3-8 项为宜
  - 不要用 todo 替代 goal_manager，两者定位不同

### T5. 完成引导（Ona 模式）

- 当最后一个 pending item 通过 update 变为 completed 时，tool result 追加：
  `"\n\n所有 todo 已完成。请总结工作成果。"`
- 不发系统消息，只在 tool result content 中追加
- 条件判断：update 前 `incomplete.length === 1 && targetId 是那个 incomplete 的`

### T6. Entry GC

- `reconstructState` 中只保留最新一条 entry 的状态
- 向前扫描旧 entries 并 splice 移除
- 从后向前删除（splice 从大索引到小索引），避免索引偏移
- 加注释说明顺序依赖

### 不做的事

- Widget（Status Line 已覆盖）
- DAG 依赖（goal_manager 的定位）
- write-all 模式（action 数量还不多）
- `/todos` TUI 交互式操作
- 跨 session 持久化
- 子任务/hierarchy
