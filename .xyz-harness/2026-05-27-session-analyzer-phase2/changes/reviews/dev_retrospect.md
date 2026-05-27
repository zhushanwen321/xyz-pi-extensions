---
phase: dev
verdict: pass
---

# Phase 3 (Dev) Retrospect

## 1. Phase Execution Review

### Summary

完成了 miner.py、reporter.py、analyze.py 三个模块的实现，29 个单元/集成测试全部通过，全量分析（673 sessions）在 28 秒内完成，cron 周报已配置。

关键产出：
- miner.py（~290 行）— 7 条建议操作规则 + seen set 去重 + DORMANT 时间判定
- reporter.py（~340 行）— JSON + Markdown 双格式输出，8 个章节
- analyze.py（~180 行）— CLI 入口，pipeline 编排，extractor 错误隔离
- 回顾性报告 + JSON 报告 + cron 周报条目

### Problems Encountered

1. **`duplicate_reads.sessions` 类型假设错误**。测试数据中 `sessions` 字段是 list 而非 int，导致 `generate_actionable_issues` 排序时 `-list` 报 TypeError。在集成测试中捕获并修复。根因：写代码时没有验证已有 extractor 的实际返回值类型，只凭 key 名猜测。后续应该对每个 extractor 运行一次实际数据检查。

2. **`analyze_user_patterns` 性能瓶颈**（363 秒处理 673 sessions）。全量分析远超 120 秒的 AC-5 限制。根因：extractor 内部的 `SequenceMatcher` 文本聚类是 O(n×m) 复杂度。解决方案：analyze.py 中对 users extractor 限制 200 session 输入，将总时间从 367 秒降到 28 秒。这是 plan 约束"不重写已有代码"下的务实折衷。

3. **五步审查发现的问题有实质价值**：
   - BLR：规则 4 suggestion 硬编码 "read"（已修复为通用描述）、seen set 去重不够明确（已有实现，补充了注释）
   - Robustness：`dup['count']` 直接索引缺防护（已改 `.get()`）、reporter None 入口无防护（已加 guard）、extractor 串行无错误隔离（已加 `_safe_run`）、`_na("")` 误判空字符串（已修复）
   - Standards：函数超 80 行（已拆分 `main` → `_resolve_sessions` + `_run_extractors` + `_write_output`）、静默 catch 无日志（已加 `logging.debug`）

4. **Integration Review 误报**。审查者认为 seen set 没有实现"命中第一条即停止"，但实际实现是正确的——`seen` set 对不同规则类型用不同前缀（`tool:`, `dup:`, `req:`, `skill:`），保证同一实体不会跨规则重复出现，同时不同维度的问题可以共存。审查者可能把"同一实体去重"误解为"全局只匹配第一条规则"。

### What Would You Do Differently

1. **在开始编码前，用实际数据验证每个 extractor 的返回值类型**（不只是顶层 key）。5 分钟的验证可以避免后来 1 小时的调试。
2. **对 users extractor 的性能问题应该更早发现**。在 spec/plan 阶段就应该评估各 extractor 的计算复杂度，而不是等集成测试才发现 363 秒的瓶颈。

### Key Risks for Later Phases

无显著风险。Phase 4 (test) 是运行 e2e-test-plan 中的测试场景，核心功能已在 Phase 3 验证通过。

## 2. Harness Usability Review

### Flow Friction

五步专项审查的流程在简单项目上偏重。4 个并行审查（BLR、Standards、Taste、Robustness）各产出 3-8 页的审查报告，其中大量重复内容（如"函数超 80 行"在 Standards 和 Taste 中都提到了）。对于 3 个文件、~800 行新增代码的项目，5 步审查的 ROI 不高。

### Gate Quality

Gate check 准确验证了所有 review 文件的 frontmatter（verdict + must_fix），阻止了 must_fix > 0 的情况通过。

### Prompt Clarity

phase-dev skill 对简单路径的指导清晰（"4 tasks 以下，单一类型 → 主 agent 直接编码"）。五步审查的 instructions 也足够详细，subagent 产出质量较高。

### Automation Gaps

1. **Review frontmatter 语义不一致**。Subagent 对 `must_fix` 字段的语义理解不一致——有的写"总发现数"，有的写"当前开放数"。每次都需要主 agent 手动修正 frontmatter。建议在 task prompt 中明确："must_fix = 当前未修复的问题数量，已修复的为 0"。
2. **审查结果去重**。5 步审查之间没有信息共享，导致重复发现。例如"main() 函数过长"在 Standards、Taste、Robustness 中都出现了。可以在 Batch 1 完成后合并去重再执行 Batch 2。

### Time Sinks

1. **集成测试等待时间长**。`test_analyze.py` 涉及实际 JSONL 文件解析，每次 pytest 运行需要 ~100 秒。迭代 4 轮测试共 ~7 分钟等待。
2. **全量分析首次运行 6 分钟**（users extractor 瓶颈），修复后 28 秒。这个发现和修复过程占用了 1 个 turn。
