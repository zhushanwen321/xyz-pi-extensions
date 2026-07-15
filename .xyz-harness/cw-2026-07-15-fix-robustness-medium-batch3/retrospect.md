# Retrospect — fix-robustness-medium-batch3

## 概述
M2 (thinkingLevel 传播) + M3 (model 空串语义) 修复。两个都是 workflow vs subagent 路径一致性问题的延续——与前几批的 ctxModel bug 同集群。

## 教训
AgentCallOpts 作为 workflow 路径的 adapter 输入类型，字段集合长期不完整（缺 thinkingLevel）。每次发现不一致都是"adapter 层压力"的体现。长期方案：统一 AgentCallOpts 和 ExecuteOptions 的字段集合，或让 workflow 直接用 ExecuteOptions。

## 量化
- commit: 1, 文件: 3, 测试: 981 passed
