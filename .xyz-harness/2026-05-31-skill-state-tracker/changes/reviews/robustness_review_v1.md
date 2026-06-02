---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 3
  dimensions_checked: 6
  issues_found: 4
  must_fix_count: 0
  low_count: 3
  info_count: 1
  duration_estimate: "8"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-05-31 18:30
- 审查文件数：3（state.ts, templates.ts, index.ts）
- 审查维度：D1-D6（全量）

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 6 | 5 | 1 | 9/10 |
| D2 异常处理 | 5 | 5 | 0 | 10/10 |
| D3 日志 | 4 | 4 | 0 | 9/10 |
| D4 Fail-fast | 6 | 6 | 0 | 10/10 |
| D5 测试友好性 | 5 | 3 | 2 | 7/10 |
| D6 调试友好性 | 4 | 4 | 0 | 9/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | LOW | D1 | turn_end remind 循环中 sendUserMessage 失败会中断后续 item 的提醒 | index.ts | ~L195 | 将单次 sendUserMessage 包在 try/catch 中，失败时 continue |
| 2 | LOW | D5 | 模块级 `let state` 闭包共享，多 session 时存在状态隔离风险 | index.ts | L133 | 已知限制（CLAUDE.md 记录），多 session 需重构为闭包内状态 |
| 3 | LOW | D5 | persistState / reconstructState / findNonTerminalByName 未 export，无法直接单元测试 | index.ts | L76-110 | 考虑将 helper 函数移到 state.ts 或独立文件并 export |
| 4 | INFO | D1 | deserializeState 中 `as TrackedItem[]` 类型断言无法在运行时验证字段类型正确性 | state.ts | L92 | 当前 `??` 默认值策略已足够防御；如需更强保障可添加运行时校验 |

## 逐文件详情

### state.ts（纯数据层，无 IO/网络/外部调用）

**D1 错误处理:**
- ✅ `deserializeState`: 每个字段用 `??` 提供默认值，向后兼容旧格式
- ✅ `extractSkillName`: 输入校验完备（尾缀检查 + 最小路径段数检查），无效输入返回 `null`
- ✅ 无外部依赖调用，无需 try/catch
- ℹ️ L92: `data.items as TrackedItem[]` — 类型断言不提供运行时保障，但后续 `??` 默认值弥补了字段缺失场景

**D2 异常处理:**
- ✅ 纯函数层不抛异常，由调用方（index.ts）负责参数校验和异常抛出
- ✅ 无空 catch 块（本文件无 try/catch）

**D3 日志:**
- ✅ 纯数据层无需日志，符合职责划分

**D4 Fail-fast:**
- ✅ `canTransition`: 终态立即返回 `false`，转换矩阵精确限定合法路径
- ✅ `extractSkillName`: 参数校验在函数入口完成
- ✅ `isTerminalStatus`: Set.has() O(1) 查找，无延迟失败

**D5 测试友好性:**
- ✅ **全部导出函数均为纯函数**，零副作用，可直接单测
- ✅ 无全局状态、无依赖注入需求
- ✅ `createInitialState()` 提供干净的初始状态工厂

**D6 调试友好性:**
- ✅ `serializeState` 输出结构化 JSON，可直接 inspect
- ✅ `extractSkillName` 返回 `null`（非 throw），调用方可区分"非 skill 路径"和"错误路径"

---

### templates.ts（纯字符串模板层）

**D1 错误处理:**
- ✅ 纯字符串拼接，无外部调用，无错误处理需求

**D2 异常处理:**
- ✅ 无异常抛出，输入总是返回 string

**D3 日志:**
- ✅ N/A — 模板函数只产出文本

**D4 Fail-fast:**
- ✅ `agentStartContextPrompt`: 空数组时返回 `""`，调用方正确检查（`if (activeItems.length === 0) return`）

**D5 测试友好性:**
- ✅ 全部纯函数，可快照测试
- ✅ 依赖仅 `TrackedItem` 类型（从 state.ts import）

**D6 调试友好性:**
- ✅ steering 提示词包含 skill 名称、id、状态、error 次数等关键上下文
- ✅ `errorForceRecordPrompt` 包含具体操作步骤，引导 AI 完成记录

---

### index.ts（扩展入口，含事件处理和工具注册）

**D1 错误处理:**
- ✅ `executeSkillState`: 参数缺失时立即 `throw new Error()`，错误信息明确（"update 操作需要 id 参数"）
- ✅ `executeSkillState`: TrackedItem 不存在时 throw（"TrackedItem id=X 不存在"）
- ✅ `persistState`: 调用 `appendEntry` + GC splice 逻辑正确（从高索引到低索引删除，不影响低索引位置）
- ✅ `reconstructState`: 找不到 entry 时返回 `createInitialState()`，降级合理
- ✅ `tool_call` handler: `sendUserMessage` 失败时，TrackedItem 已持久化（在 await 之前），仅 steering 注入丢失，不影响数据完整性
- ⚠️ L195（turn_end 循环）: `await pi.sendUserMessage(...)` 在 for 循环内，若某个 item 的 remind 调用失败，后续 item 不会收到提醒。影响有限（下一轮 turn_end 会再次尝试），但不必要地跳过了一轮提醒

**D2 异常处理:**
- ✅ 无空 catch 块
- ✅ 所有 `throw new Error()` 都包含操作上下文（id、status、转换方向）
- ✅ 异常类型统一使用 `Error`，适合 Pi 扩展的轻量级错误传播
- ✅ `canTransition` 在 throw 之前完成校验，避免非法状态变更

**D3 日志:**
- ✅ `formatItemList` 提供 id/name/status/errorCount/loadedAtTurn/detail 的完整输出
- ✅ `renderResult` 区分折叠/展开模式，展开时显示每个 item 详情
- ✅ 无敏感数据泄露（无密码、token、PII 处理）
- ✅ 无循环内高频日志

**D4 Fail-fast:**
- ✅ `executeSkillState`: 入口处校验 `params.id` 和 `params.status`，缺失立即 throw
- ✅ `executeSkillState`: 校验 item 存在性（`findIndex === -1`）
- ✅ `executeSkillState`: 校验转换合法性（`canTransition`），阻止非法变更
- ✅ `tool_call` handler: 提前 return `undefined` 过滤无关 tool 和无效 path
- ✅ `before_agent_start` handler: 空列表提前 return

**D5 测试友好性:**
- ⚠️ 模块级 `let state = createInitialState()` 被 `session_start`/`session_tree` 重建，多 session 场景共享（CLAUDE.md 已记录此已知限制）
- ⚠️ `persistState`、`reconstructState`、`findNonTerminalByName` 定义在模块作用域但未 export，单元测试需通过集成测试间接覆盖
- ✅ `executeSkillState` 参数设计清晰（pi, state, params, ctx），mock 点明确
- ✅ `renderCall`/`renderResult` 为纯渲染函数，仅需 mock theme

**D6 调试友好性:**
- ✅ 错误信息结构化，包含：操作类型、item id、当前状态、目标状态
- ✅ steering 提示词包含足够上下文（skill name, id, error count, 操作指令）
- ✅ `renderCall` 展示 action/id/status/detail 四要素，一目了然
- ✅ `renderResult` expanded 模式显示完整 item 列表及终态标记（✓）

## 亮点

1. **状态机转换矩阵设计精良**：`ALLOWED_TRANSITIONS` + `TERMINAL_STATUSES` 双重约束，`canTransition` 函数职责单一，所有转换入口统一校验
2. **纯函数与副作用清晰分离**：state.ts/templates.ts 零副作用，index.ts 集中处理 IO
3. **防御式反序列化**：`deserializeState` 每个字段 `??` 默认值，确保旧格式兼容
4. **GC 策略正确**：`persistState` 从高索引到低索引 splice，不破坏索引有效性

## 结论

**通过**。代码健壮性良好。四个维度满分（D2/D4），其余维度仅有 LOW/INFO 级别观察项，无 MUST_FIX 问题。核心数据路径（状态机转换、持久化、恢复）的错误处理完备，fail-fast 原则贯穿始终。D5 测试友好性的两个 LOW 项属于架构层面的已知取舍，不影响健壮性。
