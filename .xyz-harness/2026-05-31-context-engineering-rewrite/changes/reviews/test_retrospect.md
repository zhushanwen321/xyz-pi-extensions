---
phase: test
verdict: pass
---

# Test Phase Retrospect — context-engineering-rewrite

## 1. Phase Execution Review

### Summary

执行了 test_cases_template.json 中全部 15 个 TC，新增 4 个自动化测试（TC-2-02、TC-3-01、TC-3-02、TC-9-01），最终 44/44 测试通过。test_execution.json 覆盖全部 15 个 caseId，所有 round=1 passed=true。

核心工作是 TC→测试映射分析和 gap 填充：现有 40 个测试覆盖了 11/15 个 TC，缺少的 4 个都是 v2 新增功能的跨层交互场景（Budget per-message isolation、Frozen cross-turn、Fresh evaluation、Full pipeline order）。

### Problems Encountered

1. **TC-9-01（Full pipeline）构造了 3 版消息才通过**：
   - v1：只有一个 user 消息分隔 → turn boundary 把几乎所有 toolResult 划入同一个 turn → L0 的 protectRecentTurns=2 保护了全部，没有过期。
   - v2：加了更多 user 消息分隔，但 big toolResult 时间戳 98min > L0 expireMinutes=30min → L0 先把它过期了 → L1 看不到 12K 内容 → l1Condensed=0。
   - v3：把 big toolResult 时间戳改为 24min（< 30min L0 不过期但 > 8K L1 触发），L2 protectRecentTurns 从 3 降到 1（让 turn 2/3 中的 toolResult 也被 L2 强制过期）。3 次迭代暴露了多层压缩交互的复杂性——上一层的输出直接影响下一层的输入。

2. **TC-3-02 测试中写了无用的 `store["store"](...)` 调用**：这导致 store 中多了一个条目，store.size() 返回 2 而非 1。删除后通过。低级错误。

3. **Gate 找不到 taste_review**：文件名是 `ts_taste_review_v1.md`（Phase 3 subagent 命名），gate 脚本匹配 `taste_review_v*.md`。用 `cp` 创建别名解决。这是命名约定的不一致问题。

### What Would You Do Differently

1. **TC-9-01 应该先画 turn boundary map 再写测试**：Full pipeline 测试的核心难点是构造一个消息列表，使得每个层都有明确的触发条件且互不干扰。正确做法是先手动列出 turn boundary（每个 user/bashExecution 分隔），标注每个 toolResult 的 age、size、所在 turn，然后验证哪些层会处理它。直接写代码试错效率低。

2. **test_cases_template.json 的 TC-9-01 应该给出示例消息布局**：当前描述只说"Create complex message list"，没有给出具体的 turn/boundary 结构。这让执行者需要自己设计消息布局，增加了出错概率。

### Key Risks for Later Phases

1. **TC-9-01 的消息布局是精心构造的**：任何一层的参数变化（protectRecentTurns、keepRecent、expireMinutes、threshold）都可能打破测试。这是预期内的——如果参数变化导致行为变化，测试应该失败。

2. **findCompactBoundary 的实际格式未验证**：TC-7-01 用的是测试中模拟的 compactionSummary 字符串，没有在真实 Pi session 中验证。如果 Pi 的 compact 消息格式不同（比如用 array content），findCompactBoundary 返回 null，所有消息参与压缩。这是安全降级但影响效率。

## 2. Harness Usability Review

### Flow Friction

- **TC gap 分析全靠人工**：没有工具自动检查"哪些 TC 没有对应的自动化测试"。我手动 grep 测试文件中的 describe/it 块，逐个对照 TC ID。如果 gate 脚本能提供 `--check-coverage` 模式（对比 template 和 test_execution 的 caseId），可以减少这部分工作。
- **test_execution.json 是手写的**：15 个条目约 190 行 JSON，全部手写。如果有工具能从 vitest 输出自动生成模板，只需要填充 evidence，效率会高很多。

### Gate Quality

- Phase 4 gate 正确识别了 missing taste_review 问题（虽然根因是 Phase 3 的命名不一致）。
- test_execution.json 格式验证准确：caseId cross-reference、round 类型检查、passed 布尔检查、execute_steps 非空检查都工作正常。
- 无 false positive。

### Prompt Clarity

- test_cases_template.json 的 TC 描述质量参差：TC-1-01 到 TC-5-02 的步骤描述清晰具体（给出了时间、阈值、预期行为），TC-9-01 的描述过于笼统（"Create complex message list"）。建议 template 对集成测试给出更具体的输入构造指导。
- `verification_method` 字段在 template 中缺失（SKILL 提到应标注但 template 未包含）。不过本项目的所有 TC 都是 `integration` 类型，用自动化测试覆盖，不需要区分。

### Automation Gaps

- **TC→测试映射**：没有自动化工具检查"template 中的每个 TC 是否有对应的测试函数"。
- **test_execution.json 生成**：应该有脚本从 vitest --reporter=json 输出自动生成 test_execution.json 骨架。
- **Gate 文件名匹配**：`ts_taste_review_v1.md` vs `taste_review_v1.md` 的不一致说明 gate 对 review 文件名的匹配规则应该更宽松（只要包含 `taste` 和 `review` 就匹配）。

### Time Sinks

- **TC-9-01 消息构造迭代**：约 8 分钟（3 次试错 + 每次 30s vitest 运行）
- **test_execution.json 手写**：约 5 分钟
- **TC gap 分析**：约 3 分钟（手动 grep + 映射表）
- **Gate 文件名修复**：约 2 分钟
- **总计**：Phase 4 从开始到 gate 通过约 20 分钟
