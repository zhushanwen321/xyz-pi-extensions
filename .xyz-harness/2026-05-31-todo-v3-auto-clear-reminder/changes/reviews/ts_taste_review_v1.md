---
verdict: "fail"
must_fix: 3
reviewed_file: "todo/src/index.ts"
reviewer: taste-review
date: "2026-05-31"
---

# TypeScript 品味审查 — todo/src/index.ts (v3 变更)

## 审查范围

全文件品味审查，重点覆盖标记为 `v3:` 的新增代码区域（自动清空、Verification Nudge、Todo Reminder）。

## 维度评分

| 维度 | 评分 | 说明 |
|------|------|------|
| 命名质量 | 7/10 | 整体清晰，个别可改进 |
| 代码结构 | 6/10 | v3 逻辑侵入 execute handler，职责混杂 |
| 类型使用 | 8/10 | 无 any，union type 使用合理 |
| 条件逻辑 | 5/10 | before_agent_start 三段条件嵌套过深 |
| 一致性 | 7/10 | 与 v2 风格基本一致，少量偏差 |

---

## MUST FIX（3 项）

### M1. 模块级可变状态过多，缺乏封装

**位置**: L223-L228

```typescript
let userMessageCount: number = 0;
let allCompletedAtCount: number | null = null;
let lastTodoCallCount: number = 0;
let lastReminderCount: number | null = 0;
```

加上原有的 `todos`、`nextId`，模块级 `let` 变量达到 6 个。CLAUDE.md 明确标注这是已知的 session 隔离违反——v3 新增的 4 个变量加剧了这个问题。

**问题本质**: 这些变量有内在关联（都是"提醒/清空追踪状态"），但散落为独立 `let`。任何重置操作（`reconstructState`、clear action）必须同步维护 6 个变量，遗漏任何一个就会状态不一致。

**建议**: 将 v3 追踪状态封装为一个对象：

```typescript
interface ReminderState {
  userMessageCount: number;
  allCompletedAtCount: number | null;
  lastTodoCallCount: number;
  lastReminderCount: number;
}
let reminder: ReminderState = createInitialReminderState();
```

重置时只需 `reminder = createInitialReminderState()`，新增字段不会遗漏。

### M2. `before_agent_start` 事件处理器职责过重，条件优先级隐式

**位置**: L336-L377

```typescript
pi.on("before_agent_start", async (_event, ctx) => {
  // 1. 自动清空
  if (allCompletedAtCount !== null && ...) { ... return; }
  // 2. Verification Nudge
  if (allCompletedAtCount !== null && todos.length >= 3 && ...) { ... return; }
  // 3. Todo Reminder
  if (todos.length > 0 && allCompletedAtCount === null && ...) { ... return; }
  return undefined;
});
```

三个独立关注点（自动清空、验证提示、遗忘提醒）被平铺在一个函数里，通过隐式的 `return` 顺序实现互斥。但：

1. **互斥关系不明确**: 条件 1 和条件 2 都依赖 `allCompletedAtCount !== null`，但条件 1 会 `return` 导致条件 2 永远在条件 1 不触发时才执行。这个短路依赖没有文档或命名说明。
2. **条件 2 逻辑疑似 bug**: 当 `allCompletedAtCount !== null`（全部完成）时触发 Verification Nudge，但全部完成后应该已经过了验证窗口。触发时机在"全部完成后的下一轮"——如果 `AUTO_CLEAR_DELAY_ROUNDS = 2`，条件 1 在第 3 轮触发清空，条件 2 只有在第 1-2 轮有机会触发。但此时 todo 已经全部 `completed` 了，提醒"添加验证任务"是否还有意义？需要确认设计意图。
3. **`return undefined` 兜底**: 函数末尾的 `return undefined` 是多余的（async 函数默认返回 undefined），但前面三个分支都用 `return` 短路，风格不一致。

**建议**: 将三个检查提取为独立命名函数，用数组遍历 + first-truthy 模式：

```typescript
const CHECKS = [checkAutoClear, checkVerificationNudge, checkTodoReminder];
pi.on("before_agent_start", async (_event, ctx) => {
  for (const check of CHECKS) {
    const result = check(ctx);
    if (result) return result;
  }
});
```

### M3. `lastReminderCount` 初始值为 `0` 而非 `null`，与 `allCompletedAtCount` 不一致

**位置**: L227

```typescript
let lastReminderCount: number = 0;  // 初始 0
let allCompletedAtCount: number | null = null;  // 初始 null
```

`allCompletedAtCount` 用 `null` 表示"未触发"，`lastReminderCount` 用 `0` 表示"从未触发"。两种"未触发"用了不同的表示法。

当 `userMessageCount` 也是从 `0` 开始时，`userMessageCount - lastReminderCount >= TODO_REMINDER_INTERVAL` 在 `userMessageCount = 10` 时就会首次触发。如果这是预期行为，那没问题——但这个设计意图没有注释说明。如果 `0` 只是"随便给个初始值"，那应该改为 `null` 并在比较时显式处理。

**与 M1 关联**: 封装为 `ReminderState` 后可以统一 `null | number` 约定。

---

## SHOULD FIX（2 项）

### S1. `executeTodoAction` 函数签名 `params` 类型是内联对象，未复用 TodoParams

**位置**: L265

```typescript
function executeTodoAction(
  params: { action: string; text?: string; id?: number; texts?: string[]; ids?: number[]; status?: string },
  ctx: ExtensionContext
) {
```

`TodoParams` 已经用 Type.Object 定义了参数 schema，但 execute handler 用了一个手写的内联类型。两者可能不同步。`action` 字段在 schema 中是 `StringEnum`（有限枚举），在内联类型中是 `string`——TypeBox 的运行时校验和 TypeScript 的编译时类型之间存在 gap。

**建议**: 定义一个 `InferParams<T>` 工具类型从 TypeBox schema 推断，或手动定义 `type TodoActionParams = { action: TodoDetails["action"]; ... }` 保持同步。

### S2. `as` 类型断言散布过多

**位置**: 多处（L274, L287, L301, 等等）

`params.status as Todo["status"]`、`params.action as TodoDetails["action"]` 等断言。这些断言在 TypeBox schema 校验后是安全的，但类型系统不知道这一点。S1 的修复如果做对，可以消除大部分断言。

---

## INFO（3 项）

### I1. Unicode 转义降低可读性

大量中文字符以 `\u6682\u65e0` 形式出现（如 L143, L269）。这是构建/打包工具的副作用还是源码就是这样写的？如果是源码层面，建议用原始中文字符提高可维护性。

### I2. `getDisplayStatus` 对每次渲染都调用 `migrateTodo`

**位置**: L168

```typescript
function getDisplayStatus(t: Todo): string {
  return migrateTodo(t).status;
}
```

`migrateTodo` 内部做了 `as unknown as Record` 转换。如果数据已经在 `reconstructState` 中 migrate 过，每次渲染再 migrate 一次是冗余的。对当前规模无性能问题，但概念上不干净。

### I3. `isLastCompletion` 计算在 update 前执行，变量名准确

**位置**: L341-L346

`isLastCompletion` 的判断逻辑：在 update status 之前计算未完成数量，确认"这就是最后一个"。变量命名清晰，逻辑正确，好评。

---

## 总结

v3 新增的自动清空和提醒功能在业务逻辑层面合理，但实现上有 3 个必须修复的问题：

1. **状态散乱**（M1）— 6 个模块级 let 变量缺乏封装，重置操作容易遗漏
2. **职责混杂**（M2）— `before_agent_start` 中三个独立关注点应拆分，条件 2 的触发时机需确认
3. **约定不一致**（M3）— null vs 0 表示"未触发"，设计意图不明确

修复这 3 项后可重新提交审查。
