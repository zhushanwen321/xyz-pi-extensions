---
verdict: pass
must_fix: 0
---

# Spec Review V1 — workflow-cc-compat-v2

**审查对象**: `spec.md` (Phase 1 交付物)
**审查模式**: Plan review（验证 spec 完整性）
**审查日期**: 2026-06-09

---

## 总评

Spec 质量较高。问题定义清晰、优先级排序合理、技术方案有据可依（gap-analysis 交叉验证通过），Assumption Audit 全部 VERIFIED。FR-3 的延后决策合理且保留了完整参考。

以下分维度逐项评审。

---

## 1. 问题定义与背景 (Background)

**评分: 良好**

- 三个问题层级分明（P0 Structured Output / P1 CC 兼容 / P2 TUI），与 gap-analysis 的优先级排序一致
- 数据来源标注完整，可追溯到具体文件
- P0 问题定位准确：交叉验证 `agent-pool.ts:315-320` 确认当前是 prompt 注入而非 system prompt 注入，`state.ts:68-88` 确认 `ExecutionTraceNode` 无 `phase` 字段

**小问题**（非阻塞）：
- "Structured Output 几乎必定失败"这一描述略绝对。gap-analysis 表明是"弱模型经常忽略 prompt 指令"，强模型未必。建议改为"弱模型下 Structured Output 成功率极低"更精确。

---

## 2. 功能需求 (Functional Requirements)

### FR-1: Structured Output [P0]

**评分: 良好**

四项子需求覆盖了完整的修复链路：

| 子需求 | 覆盖 | 验证 |
|--------|------|------|
| system prompt 注入 | FR-1.1 | `--append-system-prompt` + 临时文件方案，与 gap-analysis 路径 B 一致 |
| schema JSON 安全传递 | FR-1.2 | 文件传递规避命令行限制，合理 |
| 失败自动重试 | FR-1.3 | 单次重试 + 副作用处理说明 |
| hasToolCall 盲区 | FR-1.4 | 覆盖了 agent 调用其他工具但不调 structured-output 的边界情况 |

**已验证的代码对应**：
- `agent-pool.ts:383` 确认当前逻辑：`opts.schema && parsedOutput === undefined && !hasToolCall` 才报错，确实遗漏了 "有其他工具调用但已退出" 的场景
- FR-1.4 精确定位了这一盲区

**FR-1.3 副作用处理的说明**：明确写了"重试时第一次调用的文件系统副作用会保留，脚本需自行处理幂等性"，这是诚实且务实的立场——与 CC 行为对齐。

### FR-2: CC 格式兼容 [P1]

**评分: 良好**

六项子需求逐一对应 gap-analysis 的差距：

| 子需求 | gap-analysis 对应 | 验证 |
|--------|-------------------|------|
| FR-2.1 phases 类型扩展 | 1.1 节 | `config-loader.ts:164-165` 确认当前过滤 `typeof p === "string"` |
| FR-2.2 args 别名 | 1.3 节 | `worker-script.ts:92` 确认只有 `$ARGS` |
| FR-2.3 phase 传递 | 4.2 节 | `worker-script.ts:130` 确认 `_currentPhase` 存在但未传到 orchestrator |
| FR-2.4 parallel thunk | 4.3 节 | `worker-script.ts:191-194` 确认当前不支持 thunk |
| FR-2.5 pipeline 签名 | 4.4 节 | `worker-script.ts:197-202` 确认当前只接受 stage 数组 |
| FR-2.6 budget 动态函数 | 1.4 节 | `worker-script.ts:94` 确认当前 `$BUDGET` 是静态快照 |

**FR-2.5 pipeline 错误语义**：明确写了"单个 item 某个 stage 抛错 → 该 item 结果 null → 其他 item 不受影响"，这是 CC 行为的对齐要求，对 plan 阶段有明确指导意义。

**FR-2.3 phase 覆盖规则**：全局 `_currentPhase` + 显式 `phase` 字段覆盖的优先级关系清晰。

### FR-3: TUI [P2 延后]

**评分: 良好**

延后决策合理：TUI 复杂度高（spec 自评"高"），不影响核心功能。保留了完整的需求描述、AC、和技术方案参考，下一阶段可直接使用。

---

## 3. 验收标准 (Acceptance Criteria)

**评分: 良好**

AC 与 FR 对应关系完整，每个 FR 至少有一个 AC 覆盖。Given-When-Then 风格隐含其中（"给定...条件，期望...结果"）。

**验证 AC 可测试性**：

| AC | 可自动化测试 | 备注 |
|----|-------------|------|
| AC-1.1 ~ AC-1.4 | 可通过 mock `buildArgs` / `spawnAndParse` 单元测试 | |
| AC-2.1 | 可解析 CC 格式 meta 验证 | |
| AC-2.2 | 可在 worker-script 环境中验证 `args` 变量 | 需要在 worker 线程中测试 |
| AC-2.3 | 需集成测试（agent → trace node） | |
| AC-2.4 ~ AC-2.5 | 需集成测试 | |
| AC-3.x | 需手动测试或 TUI 测试框架 | 已延后 |

**建议**（非阻塞）：AC-2.3 缺少"显式 phase 覆盖全局 _currentPhase"的用例（FR-2.3 提到了这个功能），建议补充。

---

## 4. 约束与假设 (Constraints & Assumptions)

**评分: 优秀**

- 9 项假设全部标记为 [VERIFIED]，每项标注了验证方式（源码行号、pi --help 等）
- 交叉验证抽样：
  - 假设 7（`--append-system-prompt` 自动检测文件路径）：spec 引用 `resolvePromptInput: existsSync → readFile`，这是 Pi 核心代码行为，可信
  - 假设 9（Worker 线程 parentPort 接收预算更新）：`worker-script.ts:126` 确认已有 `budget-warning` 消息通道，budget-update 可复用
- 向后兼容约束明确："现有 Pi 格式脚本必须继续工作"

**约束覆盖度**：涵盖了向后兼容、子进程限制、TUI API、CLI 参数、扩展加载、临时文件清理、行数上限。无遗漏。

---

## 5. 业务用例 (Use Cases)

**评分: 良好**

三个 UC 分别覆盖了 P0（UC-2 自动恢复）、P1（UC-1 跨平台脚本）、P2（UC-3 全屏监控，已延后）。

**UC-1 的价值**：用 CC 格式的 `review-fix-loop.js` 作为具体例子，可直接用于集成测试。交叉验证确认 `.claude/workflows/review-fix-loop.js` 确实使用了 `export const meta`、`args`、`phase('Review')`、`{label, phase, schema}` 等 CC 特有语法。

---

## 6. 复杂度评估 (Complexity Assessment)

**评分: 良好**

自评与代码实际情况一致：
- FR-1 改动集中在 `buildArgs()` 和 `spawnAndParse()`，确实低复杂度
- FR-2 pipeline 笛卡尔积确实比其他改动复杂度高
- FR-3 TUI 300+ 行的估计合理（基于 gap-analysis 的分析）

风险点识别到位，特别是 pipeline 错误传播语义和 widget.ts 行数超限。

---

## 7. 范围控制 (Out of Scope)

**评分: 良好**

明确列出了 7 项排除内容，包括嵌套 workflow、worktree 隔离、ESM 支持、FR-3 TUI 重构等。边界清晰，避免 scope creep。

---

## 8. 交叉验证摘要

| 验证项 | 结果 |
|--------|------|
| gap-analysis 问题清单 vs spec FR | 全部覆盖，无遗漏 |
| CC 脚本 `.claude/workflows/review-fix-loop.js` vs FR-2 兼容需求 | `phases: [{title, detail}]`、`args`、`phase: 'Review'`、`schema`、`label` 均已覆盖 |
| 源码现状 vs spec 描述 | `config-loader.ts`、`worker-script.ts`、`agent-pool.ts`、`state.ts` 的描述与代码一致 |
| 假设验证 | 9/9 VERIFIED，验证方式具体 |

---

## 9. 非阻塞建议

1. **AC 补充**：AC-2.3 建议增加一个用例验证"显式 phase 参数覆盖全局 _currentPhase"的行为
2. **P0 描述措辞**："几乎必定失败"改为"弱模型下成功率极低"更精确
3. **FR-1.1 临时文件路径**：spec 写 `<sessionDir>/workflow-tmp/so-<callId>.txt`，但 gap-analysis 示例用的是 `os.tmpdir()`。建议在 spec 中明确最终选择哪种（sessionDir 更合理，生命周期可控）

---

## 结论

Spec 结构完整、问题定义准确、技术方案有据可依、假设全部验证。AC 基本覆盖所有 FR，仅有一个小遗漏（显式 phase 覆盖的 AC 用例）。FR-3 延后决策合理且保留了充分参考。

**Verdict: PASS**
