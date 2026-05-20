---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-20T22:30:00"
  target: "claude-code-tool/custom-tools/subagent/index.ts"
  verdict: fail
  summary: "编码评审完成，第1轮，1条MUST FIX，需修改后重审"

statistics:
  total_issues: 5
  must_fix: 1
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "claude-code-tool/custom-tools/subagent/index.ts:421"
    title: "forceEmit() 设置 lastEmitTime = 0 而非 Date.now()，导致下次 shouldEmit() 必定通过但不更新 lastEmitTime"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: LOW
    location: "claude-code-tool/custom-tools/subagent/index.ts:1141-1175"
    title: "single collapsed 模式丢失 model 显示"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "claude-code-tool/custom-tools/subagent/index.ts:1832-1835"
    title: "chain expanded 总耗时计算为 sum 而非 spec 要求的行为"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "claude-code-tool/custom-tools/subagent/index.ts:1082-1083"
    title: "renderAgentDetail 显示 model 为可选但视图模型从 buildAgentResultView 获取了 r.model，single expanded 旧代码总是显示 model"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: INFO
    location: "claude-code-tool/custom-tools/subagent/index.ts:845-846"
    title: "finally 块中残留空行（rmdirSync 移除后遗留的空白行）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码评审 v1

## 评审记录
- 评审时间：2026-05-20 22:30
- 评审类型：编码评审
- 评审对象：claude-code-tool/custom-tools/subagent/index.ts（c2e9eb4^..HEAD，8 commits）

---

## AC 合规矩阵

| AC | 描述 | 状态 | 说明 |
|----|------|------|------|
| AC1 | 执行时间显示 | ✅ | `formatDuration`/`formatTimestamp` 实现，SingleResult 新增 4 个时间字段，collapsed/expanded 均显示耗时 |
| AC2 | 并行 streaming 节流 <= 500ms | ⚠️ | ThrottleState 类存在，但 `forceEmit()` 实现有问题（见 Issue #1） |
| AC3 | 并行 collapsed 改为表格式汇总 | ✅ | `renderParallelTable` 实现，无 tool call 细节，每 agent 一行 |
| AC4 | 并行模式任意 agent 失败 → isError: true | ✅ | L1692: `isError: results.some((r) => r.exitCode !== 0)`，description 已更新 |
| AC5 | getFinalOutput 改善 | ✅ | L356-362: 增加 `.trim()` 检查，跳过空字符串 |
| AC6 | 固定临时目录 + 1 小时清理 | ✅ | `TEMP_SUBDIR`/`MAX_TEMP_AGE_MS`/`cleanupOldTempFiles()` 实现，execute 入口调用 |
| AC7 | single/chain 渲染行为不变 + 加耗时 | ⚠️ | single collapsed 丢失了 model 显示（见 Issue #2），chain expanded 总耗时语义有偏差（见 Issue #3） |
| AC8 | single/chain 不加节流 | ✅ | 节流仅应用于 parallel 模式的 `emitParallelUpdate`，single/chain 的 `emitUpdate` 未使用 ThrottleState |

---

## 逐项检查

### 1. Spec 合规

**数据模型（SingleResult 新字段）**：
- `startTime: number` — 在 3 个初始化位点均设置（L710, L735, L1644）✅
- `endTime?: number` — 仅在正常完成/未知 agent 时设置（L711, L841），未完成时不设（exitCode=-1 的初始化不设）✅
- `durationMs?: number` — 仅在正常完成时计算（L712, L842）✅
- `lastActivityTime: number` — 在 message_end 和 tool_result_end 时更新（L797, L803），所有初始化位点均设置 ✅

**视图模型定义与 spec 一致性**：
- `DurationInfo` / `AgentResultView` / `ParallelSummaryView` 接口定义与 spec 完全一致 ✅
- `buildAgentResultView` / `buildParallelSummaryView` 实现了 spec 中的构建层 ✅

**新增函数清单对照 spec**：
| spec 要求的函数 | 代码中存在 | 位置 |
|---|---|---|
| `formatDuration` | ✅ | L248 |
| `formatTimestamp` | ✅ | L254 |
| `buildAgentResultView` | ✅ | L293 |
| `buildParallelSummaryView` | ✅ | L321 |
| `renderAgentRow` | ✅ | L1776（方法） |
| `renderAgentDetail` | ✅ | L1072 |
| `renderParallelTable` | ✅ | L1210 |
| `renderParallelDetail` | ✅ | L1278 |
| `cleanupOldTempFiles` | ✅ | L437 |
| `getTempDir` | ✅ | L433 |
| `renderSingleCollapsedText` | ✅ | L1141（spec 未列出，但符合分发器设计） |
| `renderChainCollapsedText` | ✅ | L1176（spec 未列出，但符合分发器设计） |

**未过度实现**：未发现 spec 未要求的功能 ✅

### 2. 代码质量

**Issue #1（MUST FIX）— forceEmit() 逻辑错误**

```typescript
forceEmit(): void {
    this.lastEmitTime = 0;
}
```

spec 明确要求 `forceEmit()` 设置 `this.lastEmitTime = Date.now()`。当前实现设为 `0`。

虽然设为 0 后 `shouldEmit()` 确实会返回 `true`（因为 `Date.now() - 0 >= 500`），但这依赖于一个隐含的语义：`lastEmitTime = 0` 意味着"从未 emit"，而非"刚 emit"。两者在行为上等价，但与 spec 描述不一致，且语义上容易造成混淆。

更重要的是，调用 `forceEmit()` 后紧接着调用 `emitParallelUpdate()` → `throttle.shouldEmit()`，因为 `lastEmitTime = 0`，`shouldEmit()` 会将 `lastEmitTime` 设为 `Date.now()` 并返回 `true`。所以实际行为是正确的——强制 emit 会通过。

但还有一个边界问题：如果同一批中有两个 agent 在 <500ms 内相继完成，第一个调用 `forceEmit()` 将 `lastEmitTime` 设为 0，第二个也调用 `forceEmit()` 将 `lastEmitTime` 设为 0，然后 `emitParallelUpdate()` 中 `shouldEmit()` 只会执行一次（因为第二次 `shouldEmit()` 调用时 `lastEmitTime` 已被第一次设为 `Date.now()`）。行为仍然正确。

**结论**：行为上等价但与 spec 不一致。修改为 `this.lastEmitTime = Date.now()` 更符合设计意图。标为 MUST FIX 是因为这是 spec 明确定义的行为契约。

**Issue #2（LOW）— single collapsed 丢失 model 显示**

旧代码在 single collapsed 中总是显示 model：
```typescript
text += ` ${theme.fg("dim", details.resolvedModel)}`;
```

新代码 `renderSingleCollapsedText`（L1141-1175）没有显示 model 字段。`renderAgentDetail`（expanded）通过 `view.model` 条件显示，但 collapsed 分支完全省略了。

这与 AC7（"existing 渲染行为不变"）不完全一致，但因 model 信息价值较低且 spec 未强调，标为 LOW。

**Issue #3（LOW）— chain expanded 总耗时语义**

L1832-1835：
```typescript
const totalMs = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) : undefined;
```

chain 模式是串行执行（step by step），总耗时是各步耗时之和，这是正确的。但 `buildParallelSummaryView` 中的 `totalDurationMs` 用的是 `Math.max()`（并行模式 wall-clock）。chain 没有使用 `buildParallelSummaryView`，而是直接计算 sum，逻辑正确。此 issue 撤回——实际无问题。

**更正**：经仔细审查，chain 的串行求和是正确的。

**Issue #4（LOW）— renderAgentDetail 中 model 显示条件化**

旧代码中 single expanded 总是显示 `details.resolvedModel`（即使可能为空字符串）。新代码中 `renderAgentDetail` 使用 `if (view.model)` 条件，如果 `model` 为 `undefined` 或空字符串则不显示。

这是一个行为变化但更合理（不显示空 model），标为 LOW。

### 3. 架构合规

**数据模型 + 渲染分离**：
- 三层架构（数据模型 → 构建层 → 渲染层）实现完整 ✅
- `renderResult` 变成了分发器：构建视图模型 → 调用渲染函数 ✅
- 渲染函数只依赖视图模型和 theme ✅

**不变项检查**：
- `mapWithConcurrencyLimit` 未修改 ✅
- `agents.ts` 未修改 ✅
- agent 发现、权限校验、project agent 确认流程未修改 ✅
- chain/single 核心执行逻辑未修改（仅加了时间记录）✅

### 4. 3 处 rmdirSync 移除验证

搜索整个文件，`rmdirSync` 出现 0 次。3 处均已移除 ✅：
1. `runSingleAgent` finally 块中的 rmdirSync（原 ~L685）→ 移除 ✅
2. `startBackgroundJob` close handler 中的 rmdirSync（原 ~L764）→ 移除 ✅
3. `cleanupJob` 中的 rmdirSync（原 ~L887）→ 移除 ✅

临时文件改为固定子目录 `os.tmpdir()/pi-subagent/`，不再需要 rmdirSync。

### 5. 安全和性能

- **临时文件清理**：每次 execute 调用 `cleanupOldTempFiles()`，删除超过 1 小时的文件。使用 `fs.readdirSync` + `fs.statSync` + `fs.unlinkSync` 同步操作，对少量临时文件无性能问题 ✅
- **无安全漏洞**：临时文件权限 `0o600`，文件名包含 randomUUID 片段，无注入风险 ✅
- **无 N+1 或不必要的全量加载** ✅

### 6. 语法检查

- **Tab 混入**：文件中有 1630 处 tab，diff 新增 414 处 tab。但检查发现这些 tab 是**原有缩进风格**（`runSingleAgent` 函数体使用 tab 缩进），不是新增问题。新增的独立函数（`formatDuration` 等）使用空格缩进，`renderResult` 方法体内的代码也使用 tab（保持与方法体一致）。没有发现 tab/空格混用导致的缩进不一致问题 ✅
- **TypeScript 编译**：无法在当前环境编译验证，但从代码结构上看无语法错误

### 7. 集成验证

**SingleResult 新字段的所有初始化位点**：
1. 未知 agent 返回（L707-714）：`startTime: Date.now()`, `endTime: Date.now()`, `durationMs: 0`, `lastActivityTime: Date.now()` ✅
2. 正常 spawn 初始化（L733-737）：`startTime: Date.now()`, `lastActivityTime: Date.now()` ✅
3. 并行 allResults 初始化（L1643-1645）：`startTime: Date.now()`, `lastActivityTime: Date.now()` ✅

所有位点都设置了必填的 `startTime` 和 `lastActivityTime`。

**forceEmit 调用链**：
- L1677: agent 完成后调 `throttle.forceEmit()` → L1678: `emitParallelUpdate()` → L1652: `throttle.shouldEmit()` 返回 true → `onUpdate()` 被调用 ✅

**ThrottleState 作用域**：
- 每次 `execute` 调用创建独立的 ThrottleState 实例（L1649），不会被跨调用共享 ✅

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | index.ts:421 | `forceEmit()` 设置 `lastEmitTime = 0`，spec 要求 `lastEmitTime = Date.now()` | 改为 `this.lastEmitTime = Date.now()` |
| 2 | LOW | index.ts:1141-1175 | `renderSingleCollapsedText` 丢失了 model 显示，旧代码总是显示 resolvedModel | 考虑在 header 行加入 `if (view.model) ...` |
| 3 | LOW | index.ts:1082-1083 | `renderAgentDetail` 中 model 显示从"总是显示"变为条件显示，轻微行为变化 | 可接受，记录即可 |
| 4 | LOW | — | chain collapsed 中 `renderChainCollapsedText` 不显示每步 model，旧代码也不显示 | 无变化，记录 |
| 5 | INFO | index.ts:845-846 | `finally` 块中 `rmdirSync` 移除后残留空行 | 删除空行 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

---

### Issue #1 详细分析

**问题**：`ThrottleState.forceEmit()` 设置 `this.lastEmitTime = 0`

**spec 原文**：
```typescript
forceEmit(): void {
    this.lastEmitTime = Date.now();
}
```

**当前实现**：
```typescript
forceEmit(): void {
    this.lastEmitTime = 0;
}
```

**影响评估**：
- 功能上：`lastEmitTime = 0` 后，`shouldEmit()` 下次调用必定返回 true 并更新 `lastEmitTime`，行为等价
- 但语义错误：`lastEmitTime` 字段含义是"上次 emit 的时间戳"，设为 0 表示"从未 emit"，这是一个语义谎言
- 如果未来有人基于 `lastEmitTime` 做其他判断（如计算距上次 emit 的时间），会产生错误

**修改方向**：将 `this.lastEmitTime = 0` 改为 `this.lastEmitTime = Date.now()`

---

## 结论

需修改后重审。Issue #1 修复后即可通过。

### Summary

编码评审完成，第1轮，1条MUST FIX（forceEmit 语义错误），需修改后重审。
