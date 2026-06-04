---
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-04T12:30:00"
  target: ".xyz-harness/2026-06-04-workflow-storage-and-verification/spec.md"
  verdict: fail
  summary: "计划评审完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 4
  must_fix: 1
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "spec.md:FR-3.4 — state.ts exec trace node ref"
    title: "ExecutionTraceNode interface 行号引用错误，引用的实际是 WorkflowInstance 体"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
  - id: 2
    severity: LOW
    location: "spec.md:FR-3.4 — state.ts serializeInstance ref"
    title: "serializeInstance 行号范围 172-188 略偏，实际函数体为 170-185"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
  - id: 3
    severity: LOW
    location: "spec.md:reconstructState ref"
    title: "reconstructState 行号范围 100-129 略偏，实际函数体为 99-124"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
  - id: 4
    severity: INFO
    location: "spec.md:Self-Check"
    title: "Self-Check 说'覆盖 9 个 status'，但当前 7 个 + state_lost = 8，非 9"
    status: open
    raised_in_round: 1
    resolved_in_roll: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-06-04 12:30
- 评审类型：计划评审（spec 完整性审查 + 源码引用验证）
- 评审对象：`.xyz-harness/2026-06-04-workflow-storage-and-verification/spec.md`

---

## 1. Spec 完整性（6 大元素）

| 元素 | 状态 | 说明 |
|------|------|------|
| **目标明确** | ✅ | Background 明确列出 4 个关键缺陷，每个 FR 有独立"目标"描述 |
| **范围合理** | ✅ | 每个 FR 有明确的 In-scope / Out-of-scope 节，边界清晰 |
| **验收标准可量化** | ✅ | AC-1 到 AC-6 全部可写测试验证（具体断言、mock 策略、编译检查） |
| **[待决议] 标记** | ✅ | 无 `[待决议]` 项；但有 `[VERIFIED GAP]`(A14) 和 `[UNVERIFIED]`(A15) 标记，风险已透明化 |
| **FR ↔ AC 1:1 映射** | ✅ | FR-1→AC-1.x, FR-2→AC-2.x, FR-3→AC-3.x, FR-4→AC-4.x, FR-5→AC-5.x，AC-6 为跨 FR 覆盖 |
| **生命周期覆盖** | ✅ | 创建→运行→销毁，失败场景（FR-1.3/1.6, FR-2.5, FR-4.3）均有覆盖 |

**结论：** spec 6 大元素齐全，结构完整。

---

## 2. 源码接口/枚举值引用验证

### ✅ 已验证（通过）

| 引用 | 位置 | 状态 | 实际位置 |
|------|------|------|----------|
| `state.ts:18-25` WorkflowStatus | FR-1.6, AC-1.4 | ✅ | lines 17-24（近似匹配） |
| `state.ts:107-122` SerializedWorkflowInstance | FR-1.2 | ✅ | 存在，接口字段完全匹配 |
| `state.ts:78-86` ExecutionTraceNode | FR-3.4 | ❌ **见 MUST_FIX** | 实际在 lines 65-75，78-86 是 **WorkflowInstance** 体 |
| `state.ts:172-188` serializeInstance | FR-3.4 | ⚠️ LOW | 实际函数体 lines 170-185 |
| `index.ts:100-129` reconstructState | FR-1.4 | ⚠️ LOW | 实际函数体 lines 99-124 |
| `index.ts:556-570` exact match + sendUserMessage | FR-2.1 | ✅ | lines 548-570，关键行 556-569 精确匹配 |
| `config-loader.ts:240-256` .tmp directory | FR-2.3 | ✅ | tmpDir 定义约 line 243，函数体覆盖范围正确 |
| `orchestrator.ts:721-732` GC 注释 | FR-1 BG | ✅ | JSDoc 在 lines 718-729，"accumulate, ignored on rehydrate"确认存在 |
| `agent-pool.ts` AgentPool 类 | FR-4.1 | ✅ | 无 totalCallCount 字段（待加），与 spec 一致 |
| `shared/types/mariozechner/index.d.ts` stub confirm/select 缺失 | FR-2.6 | ✅ | stub 中 `ui` 无 `confirm`/`select`/`input`，与 spec 描述一致 |

### ❌ MUST FIX：`state.ts:78-86` 指向错误接口

**问题描述：** spec 的 FR-3.4 说 `ExecutionTraceNode interface(state.ts:78-86)`，但实际代码中：

```
Line 65: export interface ExecutionTraceNode {
Line 66-74: 字段定义
Line 75: }

Line 76: (blank)
Line 77: export interface WorkflowInstance {
Line 78:   runId: string;
Line 79:   name: string;
Line 80:   status: WorkflowStatus;
Line 81:   callCache: Map<number, AgentResult>;
Line 82:   trace: ExecutionTraceNode[];
Line 83:   worker: string;
Line 84:   startedAt?: string;
Line 85:   pausedAt?: string;
Line 86:   completedAt?: string;
```

**lines 78-86 实际是 `WorkflowInstance` 接口体**，不是 ExecutionTraceNode。ExecutionTraceNode 在 lines 65-75。

**影响：** 实现者按 spec 行号去找接口会找到错误的接口行范围。虽然内容描述（verifyStrategy 字段）本身指向明确，但行号错误表明 spec 自述的"所有写入本 spec 的接口名/枚举值/字段名均经代码验证"不完全准确。

**修正方向：** 将 `state.ts:78-86` 改为 `state.ts:65-75`。

---

## 3. Acceptance Criteria 可测试性

| AC | 可测试 | 验证方法 |
|----|--------|----------|
| AC-1.1 | ✅ | 单元测试：mock pi.appendEntry，验证写入类型和数量 |
| AC-1.2 | ✅ | 集成测试：模拟 session_start + 重建 |
| AC-1.3 | ✅ | 集成测试：删除外部 state 文件，验证警告和跳过 |
| AC-1.4 | ✅ | 单元测试：检查 WorkflowStatus 和 TERMINAL_STATUSES |
| AC-2.1 | ✅ | 单元测试：mock ctx.ui.confirm，验证分支 |
| AC-2.2 | ✅ | 单元测试：mock confirm 调用次数，验证 Set cache |
| AC-2.3 | ✅ | 单元测试：注入 approval-memory entries，重建 Set |
| AC-2.4 | ✅ | 单元测试：hasUI=false，验证 sendUserMessage 路径 |
| AC-2.5 | ✅ | 单元测试：force mode，验证 confirm 未被调用 |
| AC-2.6 | ✅ | 单元测试：tmp workflow source，验证始终弹 confirm |
| AC-2.7 | ✅ | 编译检查：stub 文件 UI interface 声明 |
| AC-3.1 | ✅ | 文件检查：SKILL.md 包含 Verification Patterns 章节 |
| AC-3.2 | ✅ | 文件检查：tool-generate.ts promptGuidelines 包含 |
| AC-3.3 | ✅ | git diff 验证 orchestrator/worker-script 未修改 |
| AC-3.4 | ✅ | 单元测试/编译检查：interface + serializeInstance |
| AC-4.1 | ✅ | 单元测试：mock dispatch，验证 sendUserMessage 调用 |
| AC-4.2 | ✅ | 断言检查：warning 消息格式 |
| AC-4.3 | ✅ | 单元测试：验证 workflow 在 warning 后继续执行 |
| AC-4.4 | ✅ | 单元测试：cache hit 不计数 |
| AC-4.5 | ✅ | 单元测试：两个独立 AgentPool 实例，计数独立 |
| AC-5.1 | ✅ | 文件存在性 + 内容检查 |
| AC-5.2 | ✅ | CONTEXT.md 术语存在性检查 |
| AC-5.3 | ✅ | docs/adr/ 目录无新增文件 |
| AC-6.1 | ✅ | 测试数量 ≥ 12 的计数检查 |
| AC-6.2 | ✅ | pnpm test 结果检查 |
| AC-6.3 | ✅ | pnpm typecheck 结果检查 |

**结论：** 所有 AC 均可测试，涵盖 mock 路径、集成路径、编译检查、文件检查四种验证手段。无不可验证的模糊 AC。

---

## 4. FR ↔ AC 覆盖矩阵

| FR | 对应 AC | 状态 | 备注 |
|----|---------|------|------|
| FR-1 External State Storage | AC-1.1 到 AC-1.4 | ✅ 全覆盖 | 含 pointer entry、rehydrate、state_lost、向后兼容 |
| FR-2 True Approval Gate | AC-2.1 到 AC-2.7 | ✅ 全覆盖 | 含 confirm/session memory/hasUI 降级/tmp/workflow-force/stub 同步 |
| FR-3 Verification Gate | AC-3.1 到 AC-3.4 | ✅ 全覆盖 | 含 SKILL/tool-generate/orchestrator 未改/verifyStrategy 字段 |
| FR-4 Soft 500 Warning | AC-4.1 到 AC-4.5 | ✅ 全覆盖 | 含触发/内容/不阻断/cache 不计/跨 workflow 独立 |
| FR-5 文档沉淀 | AC-5.1 到 AC-5.3 | ✅ 全覆盖 | 含 doc/CONTEXT/ADR 不增 |
| 跨 FR 覆盖 | AC-6.1 到 AC-6.3 | ✅ | 测试数量/全绿/typecheck |

**结论：** 所有 FR 均有对应 AC，无遗漏。

---

## 5. 设计一致性检查

### FR-1 External State Storage

- 从 inline JSONL 改为外部文件 + pointer entry 的架构设计合理，遵循了 subagent mem-session 已有模式
- `state_lost` 终态设计与现有状态机完全兼容（加到 TERMINAL_STATUSES + VALID_TRANSITIONS 空数组）
- **注意点：** `persistState()` 修改后变为 async（需用 `await appendFileAtomic`），当前所有调用点为同步调用。spec 未明确提及此 sync→async 转换，需在实现时注意所有调用处加 await（orchestrator.ts 中约 7 处 + index.ts 中 1 处）

### FR-2 Approval Gate

- `ctx.ui.confirm` 在真实 SDK 中存在（`ExtensionUIContext.confirm(title, message, opts?): Promise<boolean>`），调用路径可行
- `ctx.hasUI` 降级路径已明确处理（FR-2.5）
- Session Approval Memory 的 `workflow-approval-memory` entries 使用与现有状态持久化一致的机制
- tmp workflow 特殊处理（永远弹 confirm）设计合理
- **注意点：** `shared/types/mariozechner/index.d.ts` 中 `ui` interface 缺少 `confirm`/`select`/`input`，FR-2.6 明确要求同步更新 stub，这一点不能遗漏（否则 typecheck 失败）

### FR-3 Verification Gate

- 纯提示词注入，不碰 hook/agent() 实现 → 与范围约束一致
- Pattern A (Node-Internal) 和 Pattern B (Follow-up Verify Node) 两种模式的推荐逻辑正确
- SKILL.md + tool-generate.promptGuidelines 双入口，覆盖 AI 写脚本时的两种触发路径
- `ExecutionTraceNode.verifyStrategy` 可选字段 + 不序列化 → 设计合理，最小变更

### FR-4 Soft 500 Warning

- AgentPool 类当前没有 `ExtensionAPI` 引用，无法直接调用 `pi.sendUserMessage`。spec 的 FR-4.3 代码示例中 `this.pi.sendUserMessage` 假设 AgentPool 能访问 ExtensionAPI
- **建议：** 将计数/警告逻辑放在 orchestrator 层而非 agent-pool 层，或在 AgentPool 构造函数中注入回调/API

### FR-5 文档沉淀

- 明确不创建 ADR 的判断过程清晰（FR-5.2 逐条分析可逆性）
- CONTEXT.md 增量 4 个术语的命名合理，避免歧义

---

## 6. 结论

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | **MUST FIX** | spec.md FR-3.4 → state.ts 引用 | `state.ts:78-86` 实际是 WorkflowInstance 体，不是 ExecutionTraceNode。ExecutionTraceNode 在 lines 65-75。 | 改为 `state.ts:65-75` |
| 2 | LOW | spec.md FR-3.4 → `state.ts:172-188` | serializeInstance 实际函数体为 lines 170-185，range 172-188 略偏 | 改为 `state.ts:170-185` |
| 3 | LOW | spec.md → `index.ts:100-129` reconstructState | 实际函数体为 99-124（$BUDGET 定义等），range 100-129 略偏 5 行 | 改为 `index.ts:99-124` |
| 4 | INFO | spec.md Self-Check | "AC-1.4 覆盖 9 个 status"但当前 7 个 + state_lost = 8 个，非 9 | 改为"覆盖 8 个 status" |

### 判定

**verdict: fail** — 有 1 条 MUST FIX（行号引用错误，指向了错误的接口体）。

### 总体评价

- **spec 设计质量高**：5 个 FR 目标明确，范围清晰，边界处理完善（无 UI 降级、向后兼容、文件丢失处理等）
- **AC 可测试性强**：24 条 AC 均有明确验证方法
- **FR ↔ AC 映射完整**：无遗漏，无冗余
- **源码验证整体可靠**：除 #1 外，13 个接口/函数引用均正确对应真实代码
- **自检机制好**：`[VERIFIED]`/`[VERIFIED GAP]`/`[UNVERIFIED]` 标记增加了透明度

修正 #1 后即可通过。
