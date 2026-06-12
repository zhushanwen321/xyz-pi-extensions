---
name: code-review
description: >-
  审查代码变更。触发词："review"、"审查代码"、"code review"、
  "帮我看看代码"。仅用于 xyz-pi-extensions 项目。
---

# Code Review（Coordinator）

## 角色

本 skill 现在作为审查协调器（review coordinator），不再内含维度审查逻辑。
维度审查已拆分为 5 个独立 agent，由 `review-fix-loop.js` 工作流以 `parallel()` 并行调度。

## 审查维度 → Agent 映射

| 维度 | Agent | 说明 |
|------|-------|------|
| 业务逻辑 | `review-business-logic` | 正确性、边界条件、回归风险 |
| Monorepo 影响 | `review-monorepo-impact` | workspace 依赖、循环依赖、公共 API |
| 类型安全 | `review-type-safety` | 完整标注、禁止 any、tsc 检查 |
| 扩展接口 | `review-extension-api` | Tool/Command schema、Pi manifest、向后兼容 |
| 测试覆盖 | `review-test-coverage` | 新逻辑有测试、边缘情况覆盖 |
| 代码质量（fallow） | Fallow pre-scan step | 死代码、复杂度、重复、未使用导出 |

## 直接使用（非工作流）

当用户直接说 "review" 但不在 review-fix-loop 工作流中时，AI 应：

1. **Fallow 扫描**（可选，如果 fallow 已安装）：
   ```bash
   fallow audit --base main --format json --quiet
   ```

2. **按维度逐一审查**：参考各 agent 的执行步骤，在当前会话中依次覆盖所有维度。

3. **输出格式**：与各 agent 相同的表格格式。

## 与 review-fix-loop 的关系

`review-fix-loop.js` 工作流不再通过 `skill: "code-review"` 调用本 skill，
而是直接 `parallel()` 5 个 agent + aggregator。本 skill 仅在非工作流场景下提供审查指导。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
