---
verdict: pass
---

# 无限上下文引擎 (Infinite Context Engine)

## Objective

构建一个 Pi 扩展，通过 LLM 驱动的树结构上下文压缩，使 AI coding agent 永远不会触达上下文窗口上限。原始对话记录完整保留（不修改 session entries），上下文变换仅在发送给 LLM 前执行。

## Background

大语言模型有固定的上下文窗口限制。在长时间 AI coding agent 会话中，工具调用产生的输出（文件内容、bash 输出）迅速占满上下文，导致模型丢失早期关键信息。

本扩展以**段（Segment）为叶节点的树结构**管理对话上下文。在上下文紧张时，通过 LLM 一次性决策将历史段组织为分组摘要树，保留当前工作上下文完整，同时提供 recall 工具让 LLM 按需检索被压缩的原始内容。

### 已验证的 Pi API 能力

| API | 用途 | 源码位置 |
|-----|------|---------|
| `pi.on("context", handler)` | 每次 LLM 调用前修改 messages | `agent-loop.ts:284` |
| `pi.on("session_before_compact")` | 取消/替换 Pi 原生 compaction | `compaction.ts` |
| `pi.on("turn_end")` | 提供 `turnIndex` + `message` + `toolResults` | `types.ts:580-584` |
| `pi.on("session_start")` | 恢复状态 | `agent-session.ts:2059` |
| `pi.appendEntry(type, data)` | 持久化自定义状态 | `session-manager.ts:934` |
| `ctx.sessionManager.getEntries()` | 读取全部 session entries | `session-manager.ts:184` |
| `ctx.getContextUsage()` | 返回上下文使用率（基于 raw entries，不含我们的压缩） | `agent-session.ts:2354` |

**时序**：`turn_end` → `turn_start` → `context`（`agent-loop.ts:176-219`）。
**context handler 修改不写回 state**：`getContextUsage()` 不反映我们的压缩，始终返回原始 entries 估算值。

### Pi Token 估算方式

Pi 使用 `chars/4` 启发式估算（无 tokenizer）。基准取最后一次 LLM API 返回的 `usage.totalTokens`，之后新增消息用字符数除以 4 追加估算。我们的 tree-context 估算采用相同算法。

## Functional Requirements

### FR-1: 段（Segment）索引管理

每条 user message 触发的所有 agent turn 定义为一个 Segment。新 user message 出现时标记前一段完成、新段开始。

**FR-1.1** `session_start` 时从 session entries 过滤 `customType === "ic-segment"` 恢复段索引到闭包变量。

**FR-1.2** `turn_end` 事件中检测段边界。段元数据 `{ segId, turnRange, userMessage }` 通过 `pi.appendEntry("ic-segment", data)` 持久化。

**FR-1.3** 段原始数据写入 `.pi/infinite-context/<sessionId>/seg_N.json`。此文件为 session entries 的副本提取，职责划分：
- Session entries（JSONL）：段索引 + TurnIndex 映射 + 树压缩结果 —— 通过 `pi.appendEntry` 持久化
- 文件系统（`.pi/infinite-context/`）：段原始完整 messages —— 供 recall 工具和压缩 subagent 按需读取
- 文件随 session 生命周期存在，MVP 阶段不实现自动 GC（Out of Scope 已声明）

**FR-1.4** TurnIndex 映射表：`turn_end` 中记录 `{ turnIndex, toolCalls: [{ toolCallId, toolName, entryId, params }] }`，通过 `pi.appendEntry("ic-turn", data)` 持久化。

**FR-1.5 并发压缩守卫**

`isCompressing` 布尔标志由 `TreeCompactor` 内部管理（封装性更好，外部通过 `TreeCompactor.isCompressing()` 查询）。确保同一时刻最多一个压缩进程运行。
- `turn_end` 触发压缩前调用 `treeCompactor.isCompressing()` 检查，如为 true 则跳过
- 压缩完成（成功或失败/超时）后 TreeCompactor 内部重置
- `context` handler 调用 `treeCompactor.isCompressing()` 检查，如为 true 则不设置 `needsCompression` 标志

### FR-2: 树压缩（Tree Compact）

上下文紧张时，通过 subagent 调用主模型，对历史段一次性构建摘要树。LLM 直接输出树结构（非 action list）。

**FR-2.1 触发条件**
- 自动触发：context handler 检测到 tree-context ≥70%（独立估算，非 Pi 的 `getContextUsage()`）时，设置 `needsCompression` 标志，下一轮 `turn_end` 执行压缩
- 手动触发：用户执行 `/tree-compact` 命令
- 接管原生 compaction：`session_before_compact` handler 返回 `{ cancel: true }` 取消 Pi 原生压缩

**FR-2.2 执行流程**
1. 检查 `isCompressing` 守卫：如果已有压缩正在执行，跳过本次触发
2. 设置 `isCompressing = true`，TUI 显示"正在执行树压缩..."
3. 从闭包变量读取段索引和已有树结构
4. 保留最近 2 个完整 Segment（不超过最近 8 个 turn）不参与压缩
5. 通过 `child_process.spawn`（异步）启动独立 Pi 子进程，传入所有历史段的概要信息
6. 子进程完成后：
   - 校验输出（见 FR-2.4）
   - 持久化到 session entries
   - 设置 `isCompressing = false`
   - TUI notify 压缩结果摘要
7. 压缩期间 context handler 继续使用旧树结构（不阻塞正常 LLM 调用）
8. 如果单次请求上下文超出 subagent 模型窗口，降级到规则 fallback（同 FR-2.5），不执行拆分合并。MVP 阶段不做复杂的多请求拆分——段概要数据量远小于 subagent 上下文窗口，超限仅在极端场景下发生，此时规则 fallback 已足够。

**FR-2.3 LLM 输出格式**

LLM 直接输出树结构。树中出现的节点 = 保留（带摘要）。树中不出现的段 = 被 drop（级联，含所有子孙）。

```json
{
  "children": [
    {
      "type": "group",
      "nodeId": "g0",
      "summary": "项目初始化与基础配置: Vue 3 + TS, ESLint/Prettier",
      "children": [
        { "type": "leaf", "nodeId": "seg_0" },
        { "type": "leaf", "nodeId": "seg_1" }
      ]
    },
    {
      "type": "leaf",
      "nodeId": "seg_2",
      "summary": "修复 auth JWT 刷新: 修改 token.ts/refresh.ts"
    }
  ]
}
```

- `group` 节点：包含 `children` 和 `summary`。多个段合并为一个分组。
- `leaf` 节点：对应一个原始 Segment。`leaf` 必须有 `summary` 字段（由 LLM 在树输出中直接提供，不依赖外部来源）。
- 不在树中的 `segId`：已被 drop（隐式，无需显式 action）。

**FR-2.4 输出校验与重试**

校验规则：
1. 必须是合法 JSON
2. 所有引用的 `segId` 必须存在于当前段索引
3. 同一 `segId` 不可出现两次
4. `group` 节点的 `summary` 不可为空
5. 树结构无环

校验失败处理：
- 最多重试 1 次，prompt 中附带具体错误信息
- 重试仍失败：降级到规则 fallback（所有段保留为独立 leaf，保留最近 2 段原文，其余段摘要取用户消息第一句话）
- 降级后 TUI 显示降级警告

**FR-2.5 降级机制（subagent 失败时）**

subagent 调用超时（30 秒）或返回错误时，降级到规则策略：所有历史段只保留用户消息的第一句话作为摘要，工具调用全部丢弃。保留最近 2 段完整原文。TUI 显示降级警告。

**FR-2.6 无缝执行**

压缩在 `turn_end` handler 中以异步子进程方式启动（不阻塞事件循环）。TUI 立即显示"正在执行树压缩..."状态，子进程完成后 TUI notify 结果。压缩期间：
- 用户可正常输入下一条消息
- context handler 在压缩完成前继续使用旧树结构
- `isCompressing` 守卫防止并发压缩
- 压缩完成后下一次 context handler 自动切换到新树

**不修改 `agent.state.messages`，不触发 agent loop 重启**——用户感知不到任何中断。

### FR-3: Context 消息组装

注册 `pi.on("context")` handler，每次 LLM 调用前重组 messages 数组。

**FR-3.1 独立 tree-context 估算**

每次 context handler 执行后，计算实际发给 LLM 的 token 总量（摘要 + 保留段原文），使用 `chars/4` 启发式估算。此值用于：
- 压缩触发判断（≥70% 时设置 `needsCompression`）
- `/context-status` 显示

**FR-3.2 展平算法：BFS per level, newest-to-oldest**

将树展平为 messages 时，按层级由浅到深、同层内由近及远：

```
Level 1: D 摘要 → C 摘要 → B 摘要 → A 摘要
Level 2: D.children → C.children → B.children → A.children
Level 3: D 孙节点 → C 孙节点 → ...
```

每个节点注入为 CustomMessage（Pi 内置 agent message 类型，`role: "custom"`，`customType: "ic-summary"`），文本格式为：
```
[nodeId] 摘要文字
```
其中 `nodeId` 可以是 `g0`（group）或 `seg_2`（leaf），LLM 可直接用于 recall 调用。

**FR-3.3 预算控制**

展平前计算总 tokens。如果超出上下文窗口的 80%：
1. 先从最深层开始截断（保留 Level 1 全部，砍 Level 3 中的最老节点）
2. 仍超限则砍 Level 2 中的最老节点
3. 最坏情况：只保留 Level 1 全部 + 注入提示"更早内容已折叠，使用 recall 获取详情"

**FR-3.4 Recall 提示注入**

存在被压缩的历史节点时，在 messages 开头注入 CustomMessage：
```
历史对话已压缩为摘要树。使用 recall(nodeId, mode) 工具检索被压缩内容。
recall(nodeId, "structure") 查看子树结构（不含原始内容）。
recall(nodeId, "content") 获取原始完整内容。
```

**FR-3.5 段内容处理**

- 当前活跃 Segment（最后一个）：完整原文
- 保留窗口内的已完成 Segment（最近 2 个，不超过 8 turn）：完整原文
- 已压缩的段：根据树结构注入摘要
- 未压缩的段（压缩尚未执行）：完整原文

### FR-4: Recall 检索工具

注册 `recall` 工具供 LLM 按需检索被压缩的历史内容。采用两次调用模式。

**FR-4.1 参数**
- `nodeId: string` — 树节点 ID（group 或 leaf）
- `mode: "structure" | "content"` — 默认 `"structure"`

**FR-4.2 mode: "structure"**
返回指定节点的子树结构，**不含任何 leaf 原始内容**。只返回 nodeId + type + summary + children 列表。返回量极小（几十到几百 tokens），帮助 LLM 了解子树中有什么再决定是否深入。

**FR-4.3 mode: "content"**
返回指定节点及其所有子孙 leaf 的原始完整内容（rawMessages）。从 `ctx.sessionManager.getEntries()` 和 `.pi/infinite-context/<sessionId>/seg_N.json` 获取。

**FR-4.4 两次调用模式**
1. LLM 从上下文摘要中看到 `[g0] 项目初始化与基础配置`
2. 调用 `recall({ nodeId: "g0", mode: "structure" })` → 看到 g0 下有 `[seg_0]`, `[seg_1]`
3. 决定需要 seg_0 的详情
4. 调用 `recall({ nodeId: "seg_0", mode: "content" })` → 获取原始完整 messages

**FR-4.5 错误处理**
- nodeId 不存在：返回"未找到 nodeId。使用 /context-status 查看可用节点。"
- mode 为 "content" 但 nodeId 是 group：返回该 group 所有子孙 leaf 的原始内容（递归展开）
- 空结果：返回明确的"无内容"提示

### FR-5: `/tree-compact` 命令

用户主动触发树压缩。显示 TUI 状态"正在执行树压缩..."，完成后 notify 压缩结果摘要（"压缩了 N 个段为 M 个组，释放约 P% 上下文"）。不停止对话。

### FR-6: `/context-status` 命令

在 TUI 中展示：
- **原始上下文**：Pi 报告的使用率（基于 raw entries）
- **树上下文**：我们的独立估算（实际发给 LLM 的内容大小）
- **段数量**：总数 / 已压缩 / 未压缩
- **压缩历史**：最近一次压缩时间和段数
- **Recall 使用次数**

## Acceptance Criteria

### AC-1: 段管理
- [ ] 每次新 user message 触发新 Segment 创建
- [ ] `session_start` 后能从 session entries 恢复段索引和 TurnIndex 映射
- [ ] 段原始数据正确写入 `.pi/infinite-context/<sessionId>/` 目录
- [ ] `turn_end` 正确记录 TurnIndex 映射

### AC-2: 树压缩
- [ ] tree-context ≥70% 时自动触发压缩
- [ ] `/tree-compact` 命令手动触发
- [ ] `session_before_compact` 正确取消 Pi 原生 compaction
- [ ] subagent 使用主模型 memory 模式
- [ ] LLM 返回有效 JSON 树结构（group/leaf/summary/children）
- [ ] 压缩结果持久化到 session entries
- [ ] 上下文超限时降级到规则 fallback（不拆分）
- [ ] 校验失败最多重试 1 次，之后降级到规则 fallback
- [ ] subagent 失败时降级到规则策略
- [ ] **压缩执行不停止对话**——TUI 仅显示状态消息

### AC-3: Context 组装
- [ ] 当前段 + 保留窗口使用完整原文
- [ ] 已压缩段使用摘要文字，每条带 `[nodeId]` 前缀
- [ ] 展平顺序：BFS per level, newest-to-oldest within level
- [ ] 预算超限时按深度裁剪（先砍最深层最老节点）
- [ ] Recall 提示在有被压缩段时正确注入
- [ ] 独立 tree-context 估算正确（chars/4）
- [ ] context handler 不修改 session JSONL 原始数据

### AC-4: Recall 工具
- [ ] `mode: "structure"` 返回子树结构不含原始内容
- [ ] `mode: "content"` 返回原始完整内容
- [ ] nodeId 不存在时返回明确错误
- [ ] 两次调用模式在工具描述中写明

### AC-5: 命令
- [ ] `/tree-compact` 显示状态和结果摘要
- [ ] `/context-status` 同时显示原始上下文和树上下文

### AC-6: 兼容性
- [ ] Pi 原生 compaction 被正确接管
- [ ] Pi 的 `getContextUsage()` 返回值不受影响（已知限制，`/context-status` 提供真实数据）

## Constraints

### C-1: 不改 Pi 核心
所有能力基于已有 Pi Extension API。

### C-2: 原始数据完整性
Session JSONL 中原始 entries 始终不修改。上下文变换仅在 context handler 中对 messages 副本操作。

### C-3: 压缩模型
使用主模型（subagent memory 模式）。subagent prompt 设计为结构化输出（树 JSON），控制输出 token。

### C-4: 性能
- subagent 压缩调用硬超时 30 秒，超时 kill + 降级
- context handler 执行时间 <50ms（仅内存查询和消息替换）
- 异步子进程不阻塞事件循环，用户可正常输入
- `isCompressing` 守卫确保同一时刻最多一个压缩进程

### C-5: 段边界
段划分不做语义分析，仅依据"新的 user message"。

### C-6: 保留窗口
保留最近 2 个段完整原文，但不超过最近 8 个 turn。取两者最小值。

### C-7: Token 估算
使用 `chars/4` 启发式，与 Pi 保持一致。

### C-8: Context usage 已知限制
`ctx.getContextUsage()` 不反映我们的压缩效果（它读取 raw entries，不读取 context handler 输出）。MVP 阶段接受此限制，通过 `/context-status` 提供真实 tree-context 数据。

## Out of Scope

- 跨 session 记忆迁移
- 向量/语义搜索 recall
- L1 规则压缩（工具输出替换）
- L2 段合并摘要
- 锚节点系统（不可变事实注入）
- 参数内化 / LoRA
- 多扩展 context handler 排序/优先级
- 段原始数据文件的自动 GC
- 覆写 Pi 的 `getContextUsage()` 返回值

## 业务用例

> 纯技术性基础设施需求。

### UC-1: 自动上下文压缩（无感）
- **Actor**: 系统（自动触发）
- **场景**: 长时间编码会话，tree-context 使用率超过 70%
- **预期结果**: turn_end 时自动执行树压缩，TUI 显示 3-10 秒状态消息后对话无缝继续。历史段被组织为摘要树，当前工作段保持完整。LLM 可通过 recall 工具检索被压缩内容。

### UC-2: 手动触发压缩
- **Actor**: 用户（开发者）
- **场景**: 用户主动执行 `/tree-compact`
- **预期结果**: 立即执行树压缩，显示结果摘要，对话继续。

### UC-3: 查看上下文状态
- **Actor**: 用户（开发者）
- **场景**: 用户想了解上下文真实使用情况
- **预期结果**: `/context-status` 同时显示原始上下文和树上下文的真实使用率。

## Complexity Assessment

**中等复杂度**。核心链路：

1. 段索引观察器（`turn_end` + `appendEntry`）— 与 goal 扩展模式一致
2. 树压缩（subagent memory 模式 + 结构化 JSON 输出 + 校验 + 重试）— 单次 LLM 调用
3. Context handler（BFS 展平 + 预算控制 + 独立 token 估算）— 纯同步逻辑
4. Recall 工具（nodeId 定位 + structure/content 双模式）— 标准工具实现
5. `session_before_compact` 取消原生 compaction — 一行代码

预估 ~1200 行 TypeScript。主要风险点：subagent prompt 设计（控制 LLM 输出树 JSON 格式）、BFS 展平 + 预算裁剪的边界条件、异步子进程与 context handler 之间的状态一致性（压缩完成前/后的树切换）。
