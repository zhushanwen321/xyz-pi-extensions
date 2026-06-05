# Extension 审查报告: unified-hooks

## 基本信息

| 项目 | 值 |
|------|------|
| 包名 | `@zhushanwen/pi-unified-hooks` |
| 版本 | `0.0.3` |
| 路径 | `extensions/unified-hooks/` |
| 描述 | Unified hooks extension — collect scattered hooks in one place for easy maintenance |
| 文件数 | 5 个 TypeScript 源文件 |
| 总行数 | 232 行 |
| 文件清单 | `index.ts`, `src/index.ts`, `src/hooks/test-timeout-guard.ts`, `src/hooks/tool-error-handler.ts`, `src/hooks/network-timeout-guard.ts` |

---

## 审查结果概览

| # | 规范项 | 状态 | 严重程度 | 说明 |
|---|--------|------|----------|------|
| 1 | 包结构与命名 | ⚠️ 部分合规 | P2 | `typebox` 作为 peerDependency 声明但未使用；`files` 字段包含 `src/` 整目录，可更精确 |
| 2 | 入口与工厂模式 | ✅ 合规 | — | `export default function(pi: ExtensionAPI)` 形式正确，工厂函数仅 ~25 行，无模块级 let |
| 3 | Tool 注册与设计 | N/A | — | 本扩展不注册 tool，仅使用事件钩子 |
| 4 | 事件生命周期管理 | ✅ 合规 | — | 事件处理器均 ≤ 20 行，无 agent_end/session_tree 处理器 |
| 5 | 状态与会话管理 | ✅ 合规 | — | `hooks` 状态数组在工厂闭包内，无需反序列化 |
| 6 | 错误处理与弹性 | ✅ 合规 | — | 每个 hook 注册包裹在 try-catch 中，无 process.exit，无不设上限循环 |
| 7 | 类型安全 | ❌ 不合规 | P1 | 3 个文件使用 `event: any`，应替换为具体类型或 `unknown` |
| 8 | 路径与配置 | ✅ 合规 | — | 无硬编码路径 |
| 9 | 依赖管理 | ⚠️ 部分合规 | P2 | `typebox` 在 peerDependencies 中声明但源码从未 import |
| 10 | 健壮性 | ✅ 合规 | — | 无未捕获异常、无 process.exit、无无限循环、无不支持 signal 的异步操作 |
| 11 | 代码风格 | ✅ 合规 | — | 单文件最大 98 行，函数均 ≤ 80 行，事件处理器均 ≤ 20 行 |
| 12 | Monorepo 约定 | ✅ 合规 | — | index.ts re-export 正确，import 顺序正确，所有文件 ≤ 1000 行 |

---

## 详细问题清单

### P0 问题（崩溃风险）

无。

---

### P1 问题（结构问题）

#### P1-1: 事件处理器参数使用 `any` 类型

**规范**: 第 7 条 — 禁止 `any`，必须替换为具体类型或 `unknown`。

**说明**: 三处事件处理器回调参数声明为 `any`，虽然有 `eslint-disable` 注释说明原因（Pi event types 在 CI stubs 中被类型化为 `any`），但按照规范最低应使用 `unknown` 并通过类型守卫收窄。

| 文件 | 行号 | 代码片段 |
|------|------|----------|
| `src/hooks/tool-error-handler.ts` | L11-12 | `// eslint-disable-next-line @typescript-eslint/no-explicit-any`<br>`pi.on("tool_execution_end", async (event: any) => {` |
| `src/hooks/test-timeout-guard.ts` | L75-76 | `// eslint-disable-next-line @typescript-eslint/no-explicit-any`<br>`pi.on("tool_call", async (event: any) => {` |
| `src/hooks/network-timeout-guard.ts` | L40-41 | `// eslint-disable-next-line @typescript-eslint/no-explicit-any`<br>`pi.on("tool_call", async (event: any) => {` |

**建议修复**: 定义事件类型接口或在回调参数中使用 `unknown` 后进行类型断言/守卫。例如：

```typescript
// 方案 A: 定义具体类型
interface ToolCallEvent {
  toolName: string;
  input: { command: string; timeout?: number };
}
pi.on("tool_call", async (event: ToolCallEvent) => { ... });

// 方案 B: 使用 unknown + 类型断言
pi.on("tool_call", async (event: unknown) => {
  const e = event as ToolCallEvent;
  ...
});
```

---

### P2 问题（风格问题）

#### P2-1: `typebox` 作为 peerDependency 声明但未使用

**规范**: 第 9 条 — 第三方 npm 包必须在 dependencies 中声明；第 1 条 — Pi SDK 包始终用 peerDependencies。

**文件**: `package.json`

```json
"peerDependencies": {
  "typebox": "*",
  "@mariozechner/pi-coding-agent": "*"
}
```

**说明**: `typebox`（即 `@sinclair/typebox`）被声明为 peerDependency，但整个源码中没有任何文件 import 或使用 typebox。本扩展不注册 tool，不需要定义参数 schema，因此 `typebox` 是多余的依赖声明。

**建议**: 移除 `typebox` 从 peerDependencies。

---

#### P2-2: README.md 与 CLAUDE.md 内容过时

**文件**: `README.md`, `CLAUDE.md`

**说明**: 两份文档均引用了已不存在的 hook 模块 `edit-whitespace-autofix`，且未提及当前实际存在的 `test-timeout-guard` 和 `network-timeout-guard`。

**具体问题**:

1. **README.md** 功能表中列出 `edit-whitespace-autofix`，但代码中已无此 hook（`src/index.ts` 注释中提到 "edit-stale-content-guard removed"）
2. **README.md** 文件结构部分仅显示 `tool-error-handler.ts`，缺少 `test-timeout-guard.ts` 和 `network-timeout-guard.ts`
3. **CLAUDE.md** 架构图和文件结构同样引用 `edit-whitespace-autofix.ts`，与实际代码不符

**建议**: 更新文档以反映当前实际的 hook 列表和文件结构。

---

#### P2-3: `package.json` 的 `files` 字段可更精确

**文件**: `package.json`

```json
"files": [
  "src/",
  "index.ts"
]
```

**说明**: `files` 中使用 `"src/"` 会包含 `src/` 下所有文件（含可能的测试文件、临时文件等）。虽然当前 `src/` 下只有 4 个 `.ts` 文件且全部需要发布，但更精确的做法是列出具体目录或使用 `.npmignore` 排除不需要的文件。

**严重程度**: 低。当前不会导致实际问题。

---

## 优点

1. **工厂函数设计清晰**: `src/index.ts` 使用模块化 hook 注册模式，每个 hook 独立 setup，失败不影响其他 hooks，try-catch 保护完善。
2. **代码组织良好**: 按 hook 功能拆分为独立文件，每个文件职责单一，均远低于 500 行上限。
3. **正则匹配模式设计周全**: `test-timeout-guard.ts` 和 `network-timeout-guard.ts` 中的命令检测正则考虑了管道符 `&&`、`||`、`;` 链式调用场景，覆盖面广。
4. **错误提示信息详尽**: 阻止执行时给出的 `reason` 提供了多种替代方案和推荐超时时间，对 AI 后续修正有良好引导。
5. **无模块级可变状态**: 所有状态均在工厂闭包内，符合函数式扩展设计原则。
6. **入口 re-export 规范**: `index.ts` 采用 `export { default } from "./src/index.ts"` 单行 re-export，简洁正确。
7. **无硬编码路径**: 全部使用相对路径 import，无绝对路径或环境特定路径。

---

## 改进建议

| 优先级 | 建议 | 工作量 |
|--------|------|--------|
| P1 | 将 3 处 `event: any` 替换为具体事件类型接口或 `unknown` | 小 |
| P2 | 从 `peerDependencies` 移除未使用的 `typebox` | 极小 |
| P2 | 更新 README.md 和 CLAUDE.md 以反映当前 hook 列表和文件结构 | 小 |
| 建议 | 考虑为 hook 注册结果增加 `pi.on("session_end", ...)` 清理逻辑（如需要取消订阅事件） | 中 |
| 建议 | `CLAUDE.md` 中的架构图和 API 约束文档非常有价值，建议持续与代码同步更新 | 持续 |

---

*审查日期: 2025-07-14 | 审查员: Pi Extension 规范审查 AI*
