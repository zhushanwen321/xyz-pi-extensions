---
frame: 反哺检查（execution Step 6b）
round: 4
entries: 1
---

# 反哺检查 Round 4 — execution Step 6b

> 回扫①-⑤上游，检测⑥execution 与上游矛盾。无矛盾则 entries 为执行期优化建议（非回流）。

## 反哺结论

**entries: 1（执行期优化建议，非上游矛盾）**。⑥execution 未推翻①-⑤任何决策，无需回流上游修订。

### 核验维度

1. **决策一致性**（②③ D-不可逆 vs ⑥）：⑥编排严格遵循 decisions.md 全部 confirmed 决策——D-018 两级降级链（Wave 3A）/ D-022 collectPatch 失败保 worktree（Wave 2D+4）/ D-024 reaper .alive 守卫（Wave 2D）/ D-025 #13 拆分 Wave-2 先就绪（Wave 2A 解循环）/ D-026 行为测试非 grep（验收标准标 spy）/ D-017 finalize 时序（Wave 4）。**无决策被静默偏离。**

2. **用例链不断**（①UC→③issue→⑤test-matrix→⑥Wave）：Round 1 + Step 6 审查独立确认 36 用例全链闭环，④9 条代码测试缓解项全映射，无孤立 UC / 幽灵 Wave。

3. **AC 覆盖闭环**（①AC→③issue AC→⑤test-matrix→⑥Wave 验收）：每 Wave 覆盖用例 ID 并集 = ⑤全量（Round 1 修 4 断链后 36=全量）。

4. **NFR 回灌闭环**（④缓解项→⑤章节/③issue→⑥Wave）：④9 条代码测试缓解项全闭环（清单映射表 9 行）；④2 条骨架约束（recordId 白名单/fork 日志）由⑤骨架兜住；④4 条运维项标 P3 延后（运维阶段）；④性能混沌=0 无独立 Wave。**无悬空。**

5. **骨架↔文档一致**（⑤骨架叶子→⑥Wave）：code-skeleton/ 11 .ts 文件叶子作用域一一映射到 Wave（Wave 1 types/execution-record/path-encoding；Wave 2 alive-store/SCR/finalized-marker/worktree-manager/session-file-gc；Wave 3 session-runner/record-store；Wave 4 subagent-service；Wave 5 index/subagent-tool + ADR）。**无骨架代码没被 Wave 覆盖。**

## entries

### BF-1: Wave 6 Subagent 配置补「pi CLI 触发 subagent 工具命令形态」（执行期优化，非回流）
- 来源: Step 6 审查维6 扣分点
- 性质: **执行期工程细节，非上游矛盾，不需回流①-⑤**
- 内容: Wave 6 E2E 沙盒假设「pi CLI 触发 subagent fork:true」但未给具体命令形态。subagents 是 pi extension（需 `pi install`），非交互触发 tool 的方式（`pi run` / interactive prompt / MCP 工具调用）需执行期验证。
- 处置: 在 execution-plan.md Wave 6 Subagent 配置「读取文件」补「pi CLI 触发 subagent 工具的具体命令形态（pi extension tool 调用机制，`pi --help`/`pi install` 验证）」。已落地（见 execution-plan.md Wave 6 Subagent 配置）。
- classification: D-可逆 / agent-opinionated（执行期可调，非设计决策）

## 决策账本同步

无新决策（BF-1 是执行期优化标注，非决策变更，不 append decisions.md）。
