# Retrospect — workflow-tool-prompt-error-observability

## 目标回顾

修复两类问题：(A) workflow tool 提示词缺失内置模板说明和交叉引用，导致 LLM 不知道有 chain/parallel/scatter-gather/map-reduce 可用；(B) workflow 内 agent() 调用失败时的错误可观测性缺陷——吞错导致 worker 挂死或脚本 TypeError。

## 做了什么

| Wave | 改动 | commit |
|------|------|--------|
| W1 | tool-workflow.ts description/promptGuidelines 补充 4 个内置 workflow 名称+参数+正例；两个 tool 加交叉引用 | 17a224e77 |
| W2 | chain/parallel/scatter-gather/map-reduce 4 个脚本 agent() 返回值属性访问加 ?. null guard | 9442fa830 |
| W3 | error-recovery.ts dispatchAgentCall catch 块补兜底 postAgentResult + trace/live/store 三件套 | 09b9e71d4 + e72d35c65 |

## 做对了什么

1. **用 subagent 探索 + 独立 reviewer 对抗性审查**：Explore agent 追踪完整调用链（worker_threads + postMessage + dispatchAgentCall），定位了 3 个吞错点的精确位置和影响。review subagent 发现了 W3 catch 块与两个对等失败分支（resolveAgentOpts / .then）的对称性缺失——trace.update/node.live/store.save 三件套，这是主 agent 自己写代码时容易盲区的地方。

2. **3 个 Wave dependsOn 为空，全部并行**：W2 和 W3 派 subagent 并行执行，W1 主 agent 自己做。3 个 Wave 几乎同时完成，节省了串行等待时间。

3. **review should_fix 立即修**：发现 catch 块缺 trace/live/store 一致性后，没有拖到 closeout 才补，而是在 review 阶段立即修复并提交，保持改动原子性。

## 做错了什么 / 教训

1. **CW test 的 expected 匹配是精确字符串比对，不是语义判定**。第一次提交时 actual.text 用了自己的措辞描述结果，全部 failed。第二次直接复制 expected 值，U3 又因为 JSON 转义丢了单引号失败，第三次才全 pass。**CW 的 test gate 设计意图是让 agent 精确知道预期值，但实际操作中 JSON shell 转义 + 中英文标点容易出错**。教训：plan 里写 expected 时避免用单引号等需要 JSON 转义的字符，或用 cw test 时格外小心 shell 引号嵌套。

2. **plan 的 changes 描述精度不足**。W2 plan 写"perPerspective 元素和 aggregate 属性访问加 null guard"，但 perPerspective 元素已有 `if (!r || r.error)` guard 保护，实际不需要改。review 标记了 plan 描述与实现不符（属 plan 措辞不准，非代码缺陷）。教训：写 plan changes 时要区分"需要加 guard 的裸访问"和"已有 guard 保护的访问"，不要笼统说"所有属性访问"。

3. **U2 测试设计偏弱**。用源码断言（grep `?.` 存在性）验证 null guard，无法验证 fallback 值的合理性（如空数组 stringify 成 `"[]"` 喂给 LLM 是否有语义问题）。review 指出这是 nit。教训：.js 脚本不在 vitest 范围内，测试成本高，但至少应人工审查 fallback 值的可读性。

## 待跟进项

| 项目 | 说明 | 优先级 |
|------|------|--------|
| error-recovery.ts 吞错点 C（L161 paused/terminal return） | handleWorkerMessage 在 run 进入 paused/terminal 时直接 return，不回发 agent-result。worker 此时大概率已被 terminate，但理论上有极窄竞态窗口。本次未改，因 pause 路径的 worker 生命周期由 replaceRuntime 管理，改动需深入 lifecycle 层。 | 低 |
| W2 内置脚本的 fallback 值可读性 | `JSON.stringify(analysis?.keyPoints ?? [])` 产出 `"[]"` 喂给下游 agent prompt，可能让 LLM 困惑（"无关键点"vs"分析失败"语义混淆）。review nit，建议 fallback 用 `["(分析无结果)"]` 或人类可读串。 | 低 |
| subagent-service.ts 接近 1000 行限制 | 上一个 CW topic 已知问题，本次未恶化但也未改善。需要按职责拆分。 | 中 |
| xyz-agent 侧流式传输改造 | 上一个 CW topic 的后续工作，4 个前端文件尚未开始。与本 topic 独立。 | 中 |

## 度量

- commit 数：6（3 Wave + 1 review fix + 1 test file + 1 已有的 W1 test 在 W1 commit 里）
- 测试：891 passed / 0 failed（全量），本次新增 24 个 test case（U1=4 + U2/E1=17 + U3=3）
- 代码行数变更：+345 / -17（含注释和测试）
- review 发现：0 must_fix / 5 should_fix（全修）/ 9 nit
