---
verdict: pass
must_fix: 0
---

# Spec Review V1 — workflow-cc-compat-v2

**Reviewer**: AI Code Reviewer
**Date**: 2026-06-09
**Spec**: `spec.md` (Phase 1, Plan Review Mode)

## Summary

Spec 定义了三个功能域（FR-1 Structured Output 可靠性、FR-2 CC 格式兼容、FR-3 TUI 重构延后），明确将 FR-3 推迟到下一迭代。需求完整度、技术可行性和验收标准整体质量高。以下为逐项评估。

---

## 1. 结构完整性

| 维度 | 评分 | 说明 |
|------|------|------|
| Background | ✅ | 三个问题均有数据来源引用，差距分析文档和 CC/Pi 脚本对比路径明确 |
| FR 分层 | ✅ | P0/P1/P2 优先级清晰，P2 明确延后并保留 spec 供后续使用 |
| AC 可测试 | ✅ | 每个 FR 都有对应 AC，使用 Given-Then 格式，可直接转化为测试用例 |
| Constraints | ✅ | 向后兼容、子进程限制、TUI API 验证状态、临时文件清理策略均已覆盖 |
| Assumption Audit | ✅ | 9 条假设全部标注为 VERIFIED，附验证方式 |
| 业务用例 | ✅ | UC-1/UC-2 覆盖核心场景，UC-3 标注延后 |
| Out of Scope | ✅ | 明确排除了嵌套 workflow、worktree 隔离、ESM 等 |

**结论**：结构完整，无遗漏章节。

---

## 2. FR-1 Structured Output 可靠性 — 技术方案评估

### FR-1.1 system prompt 级注入 ✅

方案：schema 指令写入临时文件 → `--append-system-prompt <路径>` → Pi 的 `resolvePromptInput` 自动读取。

**代码验证**：
- `agent-pool.ts` `buildArgs()` 当前已支持 `--append-system-prompt`（L288-290, systemPromptFile 分支）
- 假设 #7 已验证：`resolvePromptInput` 对 `existsSync` 为 true 的路径执行 `readFile`
- 临时文件位置 `<sessionDir>/workflow-tmp/so-<callId>.txt` 合理，生命周期与 session 绑定

**潜在风险**：`buildArgs()` 目前对 schema 的处理是将指令拼接到 prompt 文本中（L293-299），而 FR-1.1 改为文件注入。两套路径需要统一或去重——spec 未明确说明是否移除旧的 prompt 拼接方式。建议 plan 阶段明确。

### FR-1.2 schema JSON 安全传递 ✅

通过文件传递避免命令行长度限制和特殊字符问题。方案合理，与 FR-1.1 同一临时文件机制。

### FR-1.3 失败自动重试 ✅

**当前代码**：`agent-pool.ts` `spawnAndParse()` L327-333 已有 schema 未调用 structured-output 的失败检测。重试机制需要在 orchestrator 层实现（当前 `executeWithRetry` 仅重试子进程级别的 failure）。

**spec 要求**："自动重试一次（加强 system prompt 强调）"——意味着重试时需要不同的 prompt（更强的指令）。这与当前的 `executeWithRetry` 机制不同（当前重试用相同的 opts）。plan 阶段需设计 retry-with-enhanced-prompt 的实现方式。

**副作用处理**：spec 明确说明"靠脚本自身保证幂等性"，与 CC 对齐，合理。

### FR-1.4 hasToolCall 盲区修复 ✅

**当前代码**：`agent-pool.ts` L327-333 的逻辑是 `if (opts.schema && pipeline.parsedOutput === undefined && !pipeline.hasToolCall)`，即只在"无任何工具调用"时报错。spec 指出当子进程"调用了其他工具但没调 structured-output 且已退出"时应报错。

**注意**：当前代码有意跳过这种情况（注释解释"agent 还在工作中"），因为单轮 JSONL 流无法区分"最终轮没调"和"还会再调"。但 spec 要求 `exitCode === 0` 时视为失败——这在 `spawnAndParse` 返回时是可判断的。实现时只需修改条件为 `opts.schema && pipeline.parsedOutput === undefined && exitCode === 0`，可行。

---

## 3. FR-2 CC 格式兼容性 — 技术方案评估

### FR-2.1 phases 类型扩展 ✅

**当前代码**：`config-loader.ts` `extractMetaViaRegex()` L152 中 `phases` 过滤为 `typeof p === "string"`（L152）。需要扩展为同时支持 `{title, detail?}` 对象。

**注意**：`WorkflowMeta` 类型（L12）中 `phases: string[]` 需改为联合类型。`safeEvalObject` 用 `new Function` 求值，可以正确解析对象字面量，无阻碍。

### FR-2.2 `args` 全局别名 ✅

**当前代码**：`worker-script.ts` L67 已有 `$ARGS` 注入。只需加一行 `const args = $ARGS;`。简单直接。

### FR-2.3 phase 传递到 trace node ✅

**当前代码**：`worker-script.ts` 已有 `_currentPhase` 和 `phase()` 函数。`ExecutionTraceNode`（`state.ts` L62-77）当前无 `phase` 字段，需添加。spec 的"显式 phase 覆盖"机制需要在 `agent()` 第二参数解析中提取 `phase` 字段。

**代码验证**：`worker-script.ts` `agent()` 当前解析 `secondArg` 时提取 `schema/model/scene/description/label`（L96-102），需增加 `phase` 字段。

### FR-2.4 parallel() 支持 thunk 数组 ✅

**当前代码**：`worker-script.ts` `parallel()` L130-132 当前仅支持 `calls.map(c => agent(c))` 和函数直接调用。需要增加对 `() => Promise` thunk 的 `Promise.all` 支持。改动 < 10 行。

### FR-2.5 pipeline() 签名扩展 ✅

**当前代码**：`worker-script.ts` `pipeline()` L135-139 当前仅支持 `[stageFn]` 顺序执行。需要扩展为 `(items, stage1, stage2, ...)` 笛卡尔积模式。这是 FR-2 中最复杂的改动。

**错误语义**："单个 item 抛错 → 该 item 结果为 null → 其他不受影响"——需在 plan 中详细设计 Promise.allSettled 的处理方式。

### FR-2.6 budget 动态函数 ✅

方案合理：主线程通过 `parentPort.postMessage` 推送预算更新，Worker 缓存最新值。当前代码已有 `budget-warning` 消息通道（假设 #9），可复用。

---

## 4. 验收标准评估

| AC | 可测试性 | 评估 |
|----|---------|------|
| AC-1.1 ~ AC-1.4 | ✅ | 均为确定性条件，可编写自动化测试 |
| AC-2.1 ~ AC-2.9 | ✅ | 每个 AC 都有明确的输入/输出预期 |
| AC-3.1 ~ AC-3.5 | ⏸️ | 延后，保留参考 |

**AC-2.9**（pipeline 错误隔离）特别好——明确指定了"item 2 stage1 抛错 → 结果 null → item 1/3 正常"的边界行为。

---

## 5. 风险与建议

### 5.1 非阻塞建议（SHOULD_FIX）

**S-1**: FR-1.1 与当前 `buildArgs()` 的 prompt 拼接方式存在重叠。建议 plan 阶段明确：
- 方案 A：移除旧的 prompt 拼接，完全改用 `--append-system-prompt` 文件注入
- 方案 B：保留 prompt 拼接作为 fallback，文件注入作为主路径

推荐方案 A——减少重复逻辑，避免模型收到两份 structured-output 指令导致混淆。

**S-2**: FR-1.3 重试时的"加强 system prompt"需要具体措辞。建议 plan 中定义加强 prompt 的模板内容，避免实现时临时构造导致效果不一致。

**S-3**: FR-2.1 `config-loader.ts` 的 regex 解析当前依赖 `safeEvalObject`（`new Function`）。对象格式 `{title, detail?}` 会被正确解析，但 `detail` 中的长文本（含换行/引号）可能导致解析失败。建议 plan 中考虑 fallback 或长度截断策略。

### 5.2 观察点（INFO）

- FR-3 延后决策合理——工作量大且不影响核心功能。TUI 技术方案保留在 spec 中供下一阶段直接使用，不会丢失设计上下文。
- Out of Scope 边界清晰，避免了范围蔓延。
- Assumption Audit 全部 VERIFIED，降低了实现阶段的不确定性。

---

## 6. Conclusion

Spec 质量高，功能边界清晰，技术方案可行且有代码层面的验证支撑。3 条 SHOULD_FIX 建议可在 plan 阶段解决，不阻塞 spec 通过。

**Verdict**: **PASS**
**Blocking Issues**: 0
