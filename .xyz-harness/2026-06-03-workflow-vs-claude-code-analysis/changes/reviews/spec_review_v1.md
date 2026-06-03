---
title: "Spec Review — Workflow model-switch 集成"
verdict: pass
must_fix: 0
reviewer: self
date: 2026-06-03
---

# Spec Review: Workflow model-switch 集成

## 评审结论：PASS

## 评审维度

### 1. 完整性 ✅

- 6 个 FR 覆盖：agent() API 扩展、Orchestrator 模型解析、model-switch barrel export、依赖声明、错误处理
- 6 个 AC 覆盖：scene 选择、peak 避让、显式 model 覆盖、无 scene 默认行为、配置缺失降级、向后兼容
- 2 个业务用例
- 5 条约束

### 2. 可行性 ✅

- 所有涉及的代码路径均经过 grep 验证：
  - `agent-pool.ts:168-172` — model 通过 `--model` flag 传递 ✅
  - `worker-script.ts:55` — opts 类型可扩展 `scene` 字段 ✅
  - `orchestrator.ts:476-505` — `handleAgentCall()` 是模型解析的正确插入点 ✅
  - model-switch `computePeakRecommend()` / `computeQuotaSnapshot()` 已存在 ✅
  - model-switch `loadConfig()` 已存在，返回 null 时语义正确 ✅

### 3. 一致性 ✅

- 模型优先级（显式 model > scene > 默认）与 Claude Code Dynamic Workflows 的 API 设计一致
- 降级策略（配置缺失不阻断）与 Pi 平台的"extension 独立运行"哲学一致
- 不引入 pi-subagents 依赖，与决策 C 的约束一致

### 4. 可扩展性 ✅

- `scene` 参数设计为可选 string，未来可扩展为 `string[]` 支持多场景
- `resolveModelForScene()` 函数封装在 model-switch 内，内部逻辑升级不影响 workflow
- 未来可在此基础添加 `agent({ scene, maxCost: 0.01 })` 等预算约束

## 风险项

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| model-switch 尚未在 feat-remake-workflows 分支（`packages/`） | 需先迁移 model-switch 代码 | 作为本 spec 的前置任务或同 PR 一起迁移 |
| `readCache()` 依赖 quota-providers | 需确保 shared/quota-providers 也完成迁移 | 同上 |
