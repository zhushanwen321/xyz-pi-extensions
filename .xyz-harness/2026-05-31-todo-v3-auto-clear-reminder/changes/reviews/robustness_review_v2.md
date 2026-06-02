---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 1
  dimensions_checked: 6
  issues_found: 4
  must_fix_count: 0
  low_count: 3
  info_count: 1
  duration_estimate: "10"
---

# Robustness Review v2

## 审查记录
- 审查时间：2026-05-31
- 审查文件数：1（todo/src/index.ts）
- 审查维度：D1-D6（全量）
- 审查轮次：v2（验证 v1 MUST_FIX 修复后重新评估）
- 变更范围：v3 新增的 4 个模块级状态变量、3 个事件处理器（agent_start / before_agent_start）、executeTodoAction 中的状态追踪逻辑、reconstructState 中的 v3 状态重置

## v1 MUST_FIX 验证

### M1: `before_agent_start` 缺少错误边界 → **已修复**

v1 标记：D1/D4，运行时异常会中断整个 agent 循环。

验证结果：当前代码整体 try/catch 包裹，catch 块 `return undefined` 静默降级，注释说明设计意图。

```typescript
pi.on("before_agent_start", async (_event, ctx) => {
    try {
        // 1. auto-clear
        // 2. verification nudge
        // 3. todo reminder
        return undefined;
    } catch {
        // v3: 提醒/清空非关键路径，异常时静默降级不影响 agent 循环
        return undefined;
    }
});
```

评估：修复方案完全符合 v1 建议。所有三个分支（auto-clear / nudge / reminder）均在 try 保护下，`refreshDisplay(ctx)` 调用不会泄漏异常到 Pi 事件分发机制。

### M2: `migrateTodo` 不校验必需字段 → **降级为 LOW（已知技术债）**

v1 标记：D4，持久化数据损坏时产出非法 Todo 对象。

降级理由：
1. `migrateTodo` 是 v2 遗留代码（处理 done→status 迁移），不是 v3 引入的变更
2. 项目 CLAUDE.md 已将其标记为已知技术债
3. 实际风险极低——Pi entry 由扩展自身写入，`id`/`text` 字段在写入时已由 TypeScript 类型系统保证，损坏只能来自外部手动篡改 session 文件

保留为 LOW 而非关闭：该问题本身仍然存在，只是不属于 v3 变更审查的阻塞项。

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 6 | 6 | 0 | 9/10 |
| D2 异常处理 | 4 | 4 | 0 | 9/10 |
| D3 日志 | 4 | 2 | 2 | 5/10 |
| D4 Fail-fast | 5 | 5 | 0 | 9/10 |
| D5 测试友好性 | 4 | 1 | 3 | 3/10 |
| D6 调试友好性 | 5 | 4 | 1 | 8/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | LOW | D4 | `migrateTodo` 不验证 id/text 是否存在（v2 遗留技术债） | todo/src/index.ts | L135-144 | 添加字段存在性与类型校验，无效条目返回 null |
| 2 | LOW | D3,D6 | v3 状态转换无日志输出（auto-clear / nudge / reminder），异常行为不可追溯 | todo/src/index.ts | L614-670 | 关键分支添加 ctx.logger 或 console.debug |
| 3 | LOW | D5 | v3 状态逻辑耦合模块级变量，无法独立单元测试 | todo/src/index.ts | L206-210, L614-670 | 提取为接收 state 对象的纯函数 |
| 4 | INFO | D5 | `reconstructState` 定义在闭包内，无法导出测试 | todo/src/index.ts | L534-572 | 提取到模块顶层或 export |

## 逐文件详情

### todo/src/index.ts

**D1 错误处理:**

- ✅ `executeTodoAction` 所有 action 分支的参数校验均通过 early return 处理
- ✅ `before_agent_start` 整体 try/catch 包裹，catch 中静默降级（v1 M1 已修复）
- ✅ `reconstructState` 中 `ctx.sessionManager.getEntries()` 依赖 Pi runtime 保证可用性，失败场景由 Pi 框架处理

**D2 异常处理:**

- ✅ 无空 catch 块（`before_agent_start` 的 catch 有注释说明设计意图）
- ✅ try 块粒度适当——整体包裹三个平级分支，任一分支异常不影响后续
- ✅ Type assertions 均在参数校验之后使用

**D3 日志:**

- ✅ `execute` 中错误结果附加 `JSON.stringify(params)` 调试信息
- ⚠️ **#2** v3 三个状态转换（auto-clear / nudge / reminder）无日志记录，状态变量变化不可观测
- ⚠️ `reconstructState` 的 entry GC 和数据迁移无日志

**D4 Fail-fast:**

- ✅ `executeTodoAction` 所有参数校验在入口处完成
- ✅ `before_agent_start` 异常路径通过 try/catch 降级，不会延迟爆炸
- ✅ v3 常量提取为命名常量，语义清晰
- ⚠️ **#1** `migrateTodo` 不校验 id/text（v2 遗留，见 M2 降级说明）

**D5 测试友好性:**

- ✅ 纯辅助函数（`migrateTodo`、`renderStatusText`、`buildRender`、`renderWidgetLines`）可独立测试
- ⚠️ **#3** v3 四个模块级 `let` 变量直接被事件处理器引用，无法注入初始状态
- ⚠️ **#3** auto-clear / nudge / reminder 判定逻辑内联在闭包中，无法穷举测试
- ⚠️ **#4** `reconstructState` 定义在工厂函数闭包内，无法导出

**D6 调试友好性:**

- ✅ 错误消息具体，包含 action 类型、非法值、缺失参数名
- ✅ `details.error` 使用英文标识符，便于搜索
- ✅ `_render` 描述符包含完整 todo 列表状态
- ⚠️ **#2** v3 状态转换的触发时机（特别是 `allCompletedAtCount` 的 5 个赋值位置）缺乏统一 debug 输出

## v1→v2 维度评分变化

| 维度 | v1 评分 | v2 评分 | 变化原因 |
|------|---------|---------|---------|
| D1 错误处理 | 6/10 | 9/10 | M1 修复：`before_agent_start` 加 try/catch |
| D4 Fail-fast | 6/10 | 9/10 | M1 修复 + M2 降级（非 v3 引入） |
| D2 异常处理 | 9/10 | 9/10 | 无变化 |
| D3 日志 | 5/10 | 5/10 | 无变化（日志缺失仍为 LOW） |
| D5 测试友好性 | 3/10 | 3/10 | 无变化（模块级变量耦合仍为 LOW） |
| D6 调试友好性 | 8/10 | 8/10 | 无变化 |

## 结论

**通过**。v1 的 2 条 MUST FIX 已处理：

1. **M1 已修复**——`before_agent_start` 整体 try/catch，异常静默降级不阻断 agent 循环
2. **M2 降级为 LOW**——`migrateTodo` 是 v2 遗留技术债，非 v3 引入，不阻塞本次变更

剩余 3 条 LOW + 1 条 INFO 均为非阻塞性改进项（日志、测试友好性），建议后续迭代处理。
