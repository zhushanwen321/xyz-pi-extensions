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

## 审查 Checklist（接口契约层）

以下 checklist 来源于实际 bug 复盘（session_start handler 读错参数、subagent 工具 schema 与描述矛盾）。
审查「扩展接口」维度时 `[MANDATORY]` 逐条核对，「类型安全」维度配合 `taste/no-unsafe-cast` 规则。

### 1. SDK 接口契约核对 `[MANDATORY]`

凡调用 `pi.on(...)`、`pi.registerTool(...)`、`pi.registerCommand(...)`、读 `ctx.*` 的代码：

- [ ] **handler 参数签名**：`pi.on(event, handler)` 的 handler 必须对照真实 SDK 的 `ExtensionHandler<E> = (event: E, ctx: ExtensionContext) => ...` 签名。**两个参数**——`modelRegistry`/`cwd`/`ui`/`sessionManager` 在第二个参数 `ctx` 上，不在 event 上。
- [ ] **真实 SDK 类型核对**：打开 `node_modules/.../pi-coding-agent/dist/core/extensions/types.d.ts`（或全局安装路径）对照，不能只看 `shared/types/mariozechner/index.d.ts` 的 stub（stub 可能滞后）。
- [ ] **契约测试覆盖**：新增/修改的 SDK 调用必须有 `sdk-contract.test.ts` 覆盖——验证从 mock SDK event/ctx 到内部状态注入的完整链路。模板见 `extensions/subagents/src/__tests__/sdk-contract.test.ts`。

### 2. spec 偏差记录 `[MANDATORY]`

- [ ] 新增/修改的功能需求（FR）是否有对应的 spec 条目？无 spec 的功能不应直接实现。
- [ ] 实现与 spec 描述如有偏差，**必须**在 `spec.md` 末尾「实现偏差说明」补 D 编号记录（决策 + 原因）。偏差记录不是自愿的——未记录的偏差等于违反 spec。

### 3. schema / 描述一致性 `[MANDATORY]`

`registerTool` 的 `parameters` schema 与 `description`/`promptGuidelines` 必须一致：

- [ ] schema 必填字段（无 `Optional` 包裹）是否在所有执行模式下都真的必填？若某模式（如 `backgroundId` 轮询）会忽略其他参数，被忽略的参数不应是 schema 层必填——否则 LLM 被迫传占位值。
- [ ] 条件必填场景：schema 设为 Optional，在 `execute()` 内根据模式做运行时校验（抛清晰错误）。
- [ ] `description` 中 "Ignores X/Y/Z" 之类的描述，必须与 schema 实际行为一致。

### 4. 类型断言（配合 taste/no-unsafe-cast） `[MANDATORY]`

`no-unsafe-cast` 规则会 warn 标记 `as never`/`as any`/`as unknown as`/全可选结构断言。审查时：

- [ ] 每处 warn 的断言，确认是否有**不可替代的理由**（如跨 tsconfig 泛型冲突、SDK 类型 stub 缺失）。
- [ ] 不可替代的断言，必须有配套的**运行时 guard**（参数判空抛错）或**契约测试**兜底——不能让类型断言成为唯一防线。

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
