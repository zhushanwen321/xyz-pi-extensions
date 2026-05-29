# ADR-007: LLM 压缩输出为树结构而非 flat action list

## 上下文

树压缩需要 LLM 分析所有历史 Segment 并决定如何组织它们。有两个选择：

- **Option A**: LLM 每段返回一个 action（keep_summary / merge_with / drop），扩展再将 action list 组装成树
- **Option B**: LLM 直接输出目标树结构（JSON），扩展原样存储

## 决策

选择 Option B：LLM 直接输出树结构 JSON。

## 原因

1. **一致性保证**：Option A 的"action list → 组装树"两步增加了不一致风险（merge 引用不存在的 seg，一个 seg 出现在两个 group 等）
2. **LLM 自然倾向**：LLM 更擅长输出结构化的树 JSON 而非顺序化的操作指令——树是空间概念，action list 是过程概念
3. **校验更简单**：对完整树做一次校验（segId 存在性、无重复、无环）比逐个 action 校验再模拟组装效果更可靠
4. **Drop 语义自然**：树中不出现 = drop，无需显式 drop action

代价：LLM 需要理解树结构约束，prompt 需要示例和 schema 说明。但这是 prompt engineering 成本，非架构成本。
