# Plan Review: fix-subagent-stream-notify

**Topic**: cw-2026-07-17-fix-subagent-stream-notify
**Reviewer**: 主 agent 自审（低复杂度，3 wave 内聚明确，不派 subagent 做禁读重建）
**审查日期**: 2026-07-17

## 审查范围

跳过"禁读重建"（按 skill 备注"重建可只做关键章节，不必全量重建"）。本 plan 简单 3-wave 拆分，目标清晰，自审足够。

## 三维度审查

### 1. Coverage（覆盖度）

**FR → wave 映射**：

| FR | 对应 wave |
|---|---|
| FR-1 TUI 下 streamSink 禁用 | W1.changes[0] |
| FR-2 GUI 下 streamSink 启用 | W1.changes[0] |
| FR-3 notifier deliverAs: steer | W2.changes[0] |
| FR-4 list 返回 reminder | W3.changes[0] |
| FR-5 BG_MESSAGE 强化 | W3.changes[0] |
| FR-6 tool description 强化 | W3.changes[1] |

✓ 全部覆盖，无遗漏。

**AC → wave 验收路径**：

| AC | 验收 wave |
|---|---|
| AC-1 TUI 下 service.streamSink === null | W1.changes[1] 单元测试 |
| AC-2 GUI 下 streamSink 有值 | W1.changes[1] 单元测试 |
| AC-3 notifier 调 sendMessage 用 steer | W2.changes[1] 单元测试 |
| AC-4 list 返回 content 含 reminder | W3.changes[2] 单元测试 |
| AC-5 typecheck + lint | dev 完成后全量跑 pnpm typecheck/lint |
| AC-6 unit test 全过 | dev 完成后 pnpm -r test |

✓ 全部 AC 有验收路径。

**隐含工作检查**：
- 测试文件存在性 → dev 阶段开始时先 `ls extensions/subagent-workflow/src/__tests__/` 确认文件名（plan 里的文件名是预判）
- 现有测试是否依赖 deliverAs 字段 → dev 阶段跑全量测试时验证（fail 的话更新）
- 改动后 LLM 实际看到的 description 内容 → 单元测试只能验证字符串含关键词，端到端验证留给 manual smoke

**Coverage 结论**: ✓ 通过

### 2. Architecture（架构合理性）

**wave 拆分**：

| Wave | 改动文件数 | 主题 | 内聚度 |
|---|---|---|---|
| W1 | 2 (1 源码 + 1 测试) | streamSink 守卫 | 高（单一改动） |
| W2 | 2 (1 源码 + 1 测试) | notifier steer | 高（单一改动） |
| W3 | 3 (2 源码 + 1 测试) | reminder 强化 | 中（adapter + description + 测试，三个不同关注点） |

**dependsOn**：
- W1, W2, W3 全部 `[]` — 三个 wave 改不同文件，互不依赖
- 可并行执行（如 cw dev 支持），串行也不阻塞

**潜在拆分问题**：
- W3 改了 3 个文件略多。但 3 个文件都在 subagent 接口层（adapter + tool description + 测试），内聚度高，不拆。
- 如果 dev 时发现 subagent-tool.ts 改动过大（如需要重写整段 description），可临时拆。

**Architecture 结论**: ✓ 通过

### 3. Feasibility（可行性）

| Wave | 改动量 | 依赖 | 可执行性 |
|---|---|---|---|
| W1 | index.ts:222 加 1 行三元；测试文件加 1-2 个 case | 无外部依赖 | 一个 dev cycle 内可完成 |
| W2 | notifier.ts:132 改 1 个字段；测试加 1 case | 无 | 同上 |
| W3 | subagent-actions.ts: 改 adapter 函数 + BG_MESSAGE；subagent-tool.ts: 重写 description 段落；测试加 case | 无 | 一个 dev cycle 可完成（description 重写最长 5 分钟） |

**未识别依赖**：
- 现有 notifier 测试 mock 的 sendMessage 是否 assert options 字段 → dev 时验证
- 现有 subagent-actions 测试是否依赖 adapter 返回的 content 结构 → 同上
- 任何 fail 都在 dev cycle 内修复

**Feasibility 结论**: ✓ 通过

## 审查结论

**plan 已就绪，可进 tdd_plan**。

- Coverage: 6 FR 全覆盖，6 AC 全有验收路径
- Architecture: 3 wave 内聚、依赖清晰
- Feasibility: 改动量小，无外部依赖
- issues 列表：空

## dev 阶段注意事项

1. **测试文件存在性检查**（进入 dev 第一个动作）：
   ```bash
   ls extensions/subagent-workflow/src/__tests__/ | grep -E "subagent-(service|actions)|notifier"
   ```
   如果文件名不匹配 plan 预判，需要调整或新建。

2. **现有测试是否会 break**（进入 dev 第二个动作）：
   ```bash
   pnpm --filter @zhushanwen/pi-subagent-workflow test
   ```
   先跑 baseline，如有 fail 需先排查再改源码。

3. **commit 粒度**：每个 wave 独立 commit，message 引用 wave ID（`fix(W1): streamSink ctx.mode guard`）。

4. **不引入新依赖、不改公共 API**：stream-sink.ts / session-runner.ts API 不变。

5. **不在 dev 阶段修复 pre-commit hook 报的无关问题**：按 AGENTS.md "优先提交自己的改动" 原则，只改本 topic 相关文件。