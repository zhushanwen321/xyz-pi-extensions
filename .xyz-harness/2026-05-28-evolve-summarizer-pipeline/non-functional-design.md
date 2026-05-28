---
verdict: pass
---

# Non-Functional Design — Evolve Summarizer Pipeline

## 1. 稳定性

改动集中在新增模块（summarizer、effect-tracker、gc），对现有 judge 的 parseJudgeOutput 逻辑零修改。commands.ts 的 handleEvolve 修改是增量式的——在现有"读报告 → buildJudgeInput → runJudge"流程中间插入 summarize 步骤。如果 summarizer 出 bug（如字段缺失导致 throw），handleEvolve 外层 try-catch 会兜底报错，不会影响 Pi 进程稳定性。Judge 的重试机制（空输出重试 1 次）进一步增强了容错。

## 2. 数据一致性

所有持久化操作使用同步 fs 调用（writeFileSync/readFileSync），与现有 state.ts 模式一致。metrics-history.json 的滑动窗口通过 read → append → trim → write 实现原子性（单进程单线程，无并发写入风险）。signals/ 和 metrics-history.json 的写入在 Judge 调用之前，即使 Judge 失败，信号摘要已安全落盘，下次 evolve 可复用。

## 3. 性能

Summarizer 处理 750KB JSON：JSON.parse 约 50ms，遍历+压缩约 10ms，总计 < 100ms。不构成瓶颈。GC 在每次 evolve 时触发，扫描 reports/signals/daily 三个小目录（各 < 30 文件），耗时 < 5ms。信号摘要 ~5KB 通过 stdin 传给 pi 子进程，相比之前 745KB 通过 CLI args，避免了 OS arg length limit 和不必要的内存占用。

## 4. 业务安全

信号摘要不包含用户代码内容，只包含统计聚合数据（工具调用次数、失败率、token 数等）。LLM Judge 的 suggestion 以 unified diff 形式输出，修改的是 CLAUDE.md 或 skill 文件（这些文件本身就是 AI 行为指令）。不涉及用户代码或敏感数据的修改。Effect tracker 只对比数值指标，不读取 diff 内容。

## 5. 数据安全

所有数据存储在 `~/.pi/agent/evolution-data/`，不涉及网络传输。信号摘要和 metrics-history 只包含脱敏的统计数据。history.jsonl 包含 suggestion 的 diff 文本，但这些 diff 本身只影响 CLAUDE.md / skill 文件（AI 配置文件，不含业务数据）。文件操作使用标准 Node.js fs API，无权限提升风险。
