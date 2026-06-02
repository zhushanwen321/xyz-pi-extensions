---
verdict: pass
---

# Non-Functional Design — Evolve 扩展追踪维度

## 1. 稳定性

**影响评估：** 本变更是增量式的——新增 Python extractor 和 TypeScript detector，不修改现有 extractor 的逻辑。新 extractor 通过 `try/except` 隔离，单个 extractor 失败不会中断整个分析管道。

**风险缓解：** extractors/__init__.py 的 `run_extractors` 函数对每个 extractor 独立运行，失败时返回空 dict 并打印警告。

## 2. 数据一致性

**存储方案：** daily-reports JSON 是只写的——每次分析覆盖写入，不进行增量更新。这避免了并发写入和部分更新的问题。

**YAML frontmatter 安全性：** 不适用——本变更不涉及 YAML frontmatter 修改。

**并发控制：** 不适用——Python analyzer 是单进程运行，无并发问题。

## 3. 性能

**文件扫描：** Python extractor 扫描 session JSONL 文件，文件大小通常在 1-10MB 范围内。单次分析的时间复杂度为 O(N)，其中 N 是消息总数。对于典型的 1000 条消息的 session，分析时间在毫秒级。

**YAML 解析：** 不适用——本变更不涉及 YAML 解析。

**内存使用：** extractor 一次性加载所有 session 到内存。对于大型 session（10000+ 消息），内存使用可能达到 100MB。如果遇到性能问题，可以改为流式处理。

## 4. 业务安全

**Skill 文件影响：** 本变更修改 evolve 和 evolve-report 的 SKILL.md 文件，增加新维度的分析步骤。这些文件是 AI 的行为指令，修改需要谨慎。

**风险缓解：** 新增的分析步骤是可选的——如果 daily-reports 中没有新维度数据，分析步骤会跳过。不会影响现有分析流程。

## 5. 数据安全

**敏感信息处理：** session JSONL 可能包含用户输入和 AI 输出的敏感信息。Python extractor 只提取统计数据，不存储原始消息内容。

**文件操作权限：** Python analyzer 只读取 session JSONL 和 .xyz-harness/ 目录，不写入敏感位置。daily-reports JSON 写入到 evolution-data 目录，该目录由用户控制。
