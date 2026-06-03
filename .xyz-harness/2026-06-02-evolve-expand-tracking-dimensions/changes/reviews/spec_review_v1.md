---
title: "Spec Review — Evolve 扩展追踪维度"
verdict: pass
must_fix: 0
reviewer: self
date: 2026-06-02
---

# Spec Review: Evolve 扩展追踪维度

## 评审结论：PASS

## 评审维度

### 1. 完整性 ✅

- 6 个追踪维度均有详细设计
- 每个维度包含：问题定义、信号源、可追踪数据、不能追踪的数据、产出数据结构、Miner 规则
- 数据流路径清晰：Session JSONL → Extractor → daily-reports → /evolve → suggestions

### 2. 可行性 ✅

- 所有信号源均基于 session JSONL 中已有的数据
- 明确标注了"不能追踪"的数据，避免了不可实现的设计
- Python extractor 的自动发现机制已在 4-layer 架构文档中定义

### 3. 一致性 ✅

- 与 003-evolve-redesign-4-layer.md 的四层架构一致
- Problem Registry 定位明确（索引 + 阈值 + 模板，不驱动 L2/L3）
- 与现有 8 维 extractor 的数据结构风格一致

### 4. 可扩展性 ✅

- 每个新维度 = 1 个 extractor + 1-2 条 rule + 1 个 detector
- 不修改已有代码
- 阈值配置集中在 config.py 中

## 风险项

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 上下文利用率精度有限 | 只能粗略估算 | 明确标注为趋势观察指标，不用于精确决策 |
| Subagent 耗时不可追踪 | 无法分析执行效率 | 从 result 内容中解析 durationMs（如果存在） |
| workflow 数据依赖 .xyz-harness/ 目录 | 无 workflow 时数据为空 | extractor 优雅处理目录不存在的情况 |
