---
phase: test
verdict: pass
---

# Test Phase Retrospect

## 1. Phase Execution Review

### Summary

Phase 4 为 16 个集成测试用例编写了完整的集成测试文件（`integration.test.ts`，~300 行），覆盖 test_cases_template.json 中全部 TC。执行过程中 4 个 TC 在 round 1 失败（测试代码 bug，非实现 bug），修复后 round 2 全部通过。最终结果：23/23 测试通过（7 单元 + 16 集成）。

### Problems Encountered

| 问题 | 影响 | 根因 | 解决方式 |
|------|------|------|---------|
| TC-1-01 round 1 失败：toolResult 未过期 | 测试逻辑错误 | 构造的 2-turn 序列中，35min 的 toolResult 仍在 protectRecentTurns=2 保护范围内。未理解 turn boundary 的精确定义——保护的是最近 N 个 turn，而非"超过 30 分钟就过期" | 增加 Turn 0 使 oldest toolResult 落在保护范围外 |
| TC-5-01 round 1 失败：`store.store("L0", content)` 参数反了 | 测试代码错误 | 没有检查 recall-store.ts 的 `store(content, level)` 签名，凭直觉写了 `store(level, content)` | 翻转参数顺序为 `store(content, level)` |
| TC-7-01 round 1 失败：内容仅 6714 字符 < 8000 阈值 | 测试数据不足 | filler 行太短（`"  return x + y;"` 仅 14 字符），400 行 × 14 ≈ 5600 字符不够 | 增加 filler 到 600 行，使用更长的字符串 |
| TC-10-01 round 1 失败：`"off"` 未被 parseLevelArgs 识别 | 测试代码错误 | 凭直觉假设 `"off"` 是全局禁用命令，但 parseLevelArgs 要求 `"global off"` | 改为 `"global off"` |

**关键观察：4 个失败全部是测试代码 bug，不是实现 bug。** 这暴露了"先写测试不跑就提交"的问题。

### What Would You Do Differently

1. **先检查 API 签名再写测试**：TC-5-01 的参数顺序错误完全可以避免——写测试前应该 `grep` 一下函数签名，而不是凭记忆。这和 Phase 3 中"先读再写"的铁律一致。

2. **测试数据应验证前置条件**：TC-7-01 的 `expect(longContent.length).toBeGreaterThan(8000)` 断言在 round 1 就失败了。这是好的实践——前置断言能快速定位问题。应该在所有依赖数据阈值的测试中都加前置断言。

3. **TC-1-01 的 turn boundary 理解偏差**：写了 `protectRecentTurns=2` 但只构造了 2 个 turn，导致所有 toolResult 都在保护范围内。正确理解应该是"排除最近 2 个 turn 后，更早的 turn 中的 toolResult 才会被过期"。需要在 plan 阶段就对每个 TC 的消息序列做更精确的设计。

4. **不应假设命令语法**：TC-10-01 假设 `"off"` 等价于全局禁用，但实际需要 `"global off"`。应该从 commands.ts 的 parseLevelArgs 文档或实现中确认命令格式。

### Key Risks for Later Phases

1. **L1 对非代码内容的摘要质量**：TC-7-02 只验证了 fallback 走截断路径，没有验证截断后的信息密度。实际使用中，JSON/YAML 输出截断可能丢失关键结构信息（如 JSON 数组截断到一半导致无法解析）。

2. **L2 在真实 Pi session 中的触发频率**：测试中 mock 了 `contextUsage.percent=0.91`，但真实 Pi session 中 context 事件的调用频率和 percent 的精确值取决于 Pi 核心的实现。如果 percent 字段始终为 null（某些 provider 不返回 usage），L2 的 fallback 估算（chars/4/200000）可能不准确。

3. **recall store 无 GC**：Phase 3 的 robustness review 已标记为 LOW，但 Phase 4 测试中未覆盖长 session 场景。如果 session 中有数千次压缩，Map 会持续增长。

## 2. Harness Usability Review

### Flow Friction

- **test_execution.json 的手动编写成本高**：20 条记录需要从测试输出手工提取 caseId、round、passed、execute_steps。对于 16 个 TC（部分有 2 轮），这占了 Phase 4 约 30% 的时间。理想情况下，vitest 测试框架应该能自动生成此文件。
- **FR→TC 覆盖矩阵检查是手动的**：Skill 要求验证"每条 FR 至少有一个 TC 覆盖"，但实际上 test_cases_template.json 的 description 字段已经标注了 AC 关联（如 `AC-1:`）。这个检查可以脚本化。

### Gate Quality

- **Gate 一次 PASS**：test_execution.json 格式正确，所有最终轮次通过，无 missing TC。Gate 检查准确且高效。
- **无 false positive**：Gate 检查的 cross-reference（template TC IDs vs execution caseIds）精确匹配。

### Prompt Clarity

- **Skill 步骤清晰**：1→Load Templates → 2→Execute → 3→Record → 4→Fix → 5→Self-Check → 6→Commit → 7→Gate。线性流程，无歧义。
- **test_execution.json 字段 Schema 描述详尽**：表格形式的字段说明 + 完整示例 + 常见错误列，消除了格式歧义。
- **"不执行 UI 级 E2E"的限定合理**：16 个 TC 全部是 `integration` 类型，不涉及 UI，符合插件项目的实际情况。

### Automation Gaps

- **test_execution.json 应由测试框架自动生成**：可以写一个 vitest reporter 插件，在测试完成后自动生成符合 schema 的 JSON。这会消除手动编写的主要摩擦。
- **FR→TC 覆盖矩阵应脚本化**：从 test_cases_template.json 中提取 AC ref，与 spec.md 的 AC 列表做 diff，自动生成覆盖报告。
- **Self-Check 中的 JSON 验证脚本**：Skill 建议运行 `check_gate.py`，但 Phase 4 中我用了 Python 一行脚本手动验证。这个脚本应该在 harness 初始化时就可用。

### Time Sinks

- **最大消耗：test_execution.json 手动编写**：20 条记录，每条需要从测试结果中提取信息并格式化。约占 Phase 4 总时间的 30%。
- **次要消耗：修复 4 个 round 1 失败**：每个修复约 1-2 分钟（改参数顺序、增加 filler、修正 turn 构造）。如果写测试时更仔细地检查 API 签名，这些可以避免。
