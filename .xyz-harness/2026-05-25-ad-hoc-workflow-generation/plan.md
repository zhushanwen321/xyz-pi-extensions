---
verdict: pass
---

# Ad-hoc Workflow Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use xyz-harness-subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 Workflow Extension，支持自然语言生成临时 workflow、智能路由复用已有 workflow、选择性保存。

**Architecture:** 在现有 workflow 扩展内新增 1 个 tool（`workflow-generate`）和 1 个命令子命令（`/workflow save`），增强 3 个现有模块（config-loader 扫描、commands 路由、widget 面板）。临时 workflow 存放在 `.pi/workflows/.tmp/`，通过 `source` 字段区分 saved/tmp。

**Tech Stack:** TypeScript, Pi Extension API (typebox, registerTool, registerCommand, registerShortcut, sendUserMessage), worker_threads (不改动)

---

## File Structure

| File | Type | Group | Description |
|------|------|-------|-------------|
| `workflow/src/config-loader.ts` | modify | G1 | 新增 .tmp 扫描、source 字段、去重优先级 |
| `workflow/src/commands.ts` | modify | G2 | 新增 save 子命令、增强 default handler 传递 workflow 列表 |
| `workflow/src/index.ts` | modify | G2 | 注册 workflow-generate tool |
| `workflow/src/widget.ts` | modify | G3 | [tmp]/[saved] 标签、面板 Save/Delete 操作 |
| `workflow/src/state.ts` | modify | G1 | WorkflowMeta 新增 source 字段 |

---

## Task List

| # | Task | Depends on | Group |
|---|------|-----------|-------|
| 1 | config-loader + state: .tmp 扫描与 source 标记 | — | G1 |
| 2 | commands: save 子命令 + 智能路由增强 | 1 | G2 |
| 3 | index: workflow-generate tool 注册 | 1 | G2 |
| 4 | widget: [tmp]/[saved] 标签 + 面板操作增强 | 1 | G3 |

---

### Task 1: config-loader + state — .tmp 扫描与 source 标记

**Type:** backend

**Files:**
- Modify: `workflow/src/state.ts` — WorkflowMeta 接口新增 `source` 和 `path` 字段
- Modify: `workflow/src/config-loader.ts` — scanWorkflows 新增 .tmp 目录、去重优先级

**实现要点:**

- `state.ts` 的 `WorkflowMeta` 接口新增字段:
  - `source: "saved" | "tmp"` — 区分固定/临时
  - `path: string` — 完整文件路径（用于 save 的文件移动和 generate 的路径返回）

- `config-loader.ts` 的 `scanWorkflows()` 函数:
  - 新增第三个扫描目录 `.pi/workflows/.tmp/`
  - 每个扫描到的 workflow 根据所在目录标记 `source`
  - `.pi/workflows/` 和 `~/.pi/agent/workflows/` → `"saved"`
  - `.pi/workflows/.tmp/` → `"tmp"`
  - 去重优先级：同名 workflow，`.tmp/` > `.pi/workflows/` > `~/.pi/agent/workflows/`
  - `.tmp/` 目录不存在时不报错（返回空数组），不影响其他目录扫描

- 验证: `npx tsc --noEmit` 通过

---

### Task 2: commands — save 子命令 + 智能路由增强

**Type:** backend

**Depends on:** Task 1（依赖 scanWorkflows 返回 source/path）

**Files:**
- Modify: `workflow/src/commands.ts`

**实现要点:**

**save 子命令:**
- switch 中新增 `case "save":` 分支
- 解析 `parts[1]` 为 tmp-name，可选 `--as <new-name>` 参数
- 调用 `saveWorkflow(name, newName)` 共用函数
- 目标已存在时拒绝，返回 error 通知
- 源文件不存在时拒绝

**共用函数提取:**
- 从 save 逻辑中提取 `saveWorkflow(name: string, newName?: string): void` 导出函数
- 新增 `deleteWorkflow(name: string, runningCheck: (name: string) => boolean): void` 导出函数
- deleteWorkflow 删除前检查 running 状态，有则抛出错误
- 这两个函数供 widget.ts import 调用

**default handler 增强:**
- 现有 default handler 已经调用 `api.sendUserMessage()`
- 改为：先调 `scanWorkflows()` 获取完整列表（含 name/description/source/path），序列化为文本列表拼接到消息中
- 消息格式: "用户想执行: '{原始输入}'\n可用 workflow 列表:\n  [saved] name — description\n  [tmp] name — description\n请判断匹配或新建"
- 需要 import config-loader 的 scanWorkflows

**run 分支 not-found 增强:**
- 现有 catch 已有 not-found 传回 AI 的逻辑，保持不变

---

### Task 3: index — workflow-generate tool 注册

**Type:** backend

**Depends on:** Task 1（依赖 WorkflowMeta 类型）

**Files:**
- Modify: `workflow/src/index.ts`

**实现要点:**

**新 tool `workflow-generate`:**
- 参数 schema (typebox):
  - `name: Type.String()` — 必需
  - `script: Type.String()` — 必需
  - `description: Type.Optional(Type.String())` — 可选

- execute 逻辑:
  1. 调用 `scanWorkflows()` 检查 name 冲突（saved + tmp 都检查），冲突则 `throw new Error("名称冲突: ...")`
  2. 用 `new Function(script)` 做语法校验，失败则 `throw new Error("语法错误: ...")`
  3. 验证 script 包含 `const meta =` 或 `export const meta =`，不包含则 `throw new Error("缺少 meta 导出")`
  4. `fs.mkdirSync(".pi/workflows/.tmp", { recursive: true })`
  5. `fs.writeFileSync(".pi/workflows/.tmp/{name}.js", script, "utf-8")`
  6. 返回 `{ content: [{ text: "脚本已生成: .pi/workflows/.tmp/{name}.js" }], details: { path: "...", name: "...", status: "ready" } }`

- tool description: "生成临时 workflow 脚本。AI 根据用户自然语言描述生成 JS 脚本，写入 .pi/workflows/.tmp/。执行前必须让用户确认脚本路径。"
- 需要 import `fs`, `path`, config-loader 的 `scanWorkflows`

---

### Task 4: widget — [tmp]/[saved] 标签 + 面板操作增强

**Type:** frontend

**Depends on:** Task 1（依赖 source 字段）

**Files:**
- Modify: `workflow/src/widget.ts`

**实现要点:**

**标签展示:**
- renderWorkflowList 或等效渲染函数中，在每个 workflow 名称前加 `[tmp]` 或 `[saved]` 标签
- 用 `theme.fg("accent", "[tmp]")` 和 `theme.fg("success", "[saved]")` 区分颜色

**面板操作增强（registerShortcut 或面板内交互）:**
- `/workflows` 面板中选中某个 workflow 后:
  - `r` 键 — Run（显示脚本路径，通知用户确认后执行）
  - `s` 键 — Save（仅 tmp workflow 可用，import 并调用 commands.ts 的 `saveWorkflow()`）
  - `d` 键 — Delete（import 并调用 commands.ts 的 `deleteWorkflow()`，检查 running 实例）
- 不需要修改 commands.ts（G2 已提取共用函数）

---

## Execution Groups

#### G1: 基础设施 — config-loader + state

**Description:** 数据模型和扫描逻辑的增强，为后续 task 提供 source/path 信息。

**Tasks:** Task 1

**Files (预估):** 2 个文件修改

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 1 描述 + spec FR4 全部 + spec Decisions |
| 读取文件 | workflow/src/state.ts, workflow/src/config-loader.ts, CLAUDE.md |
| 修改文件 | workflow/src/state.ts, workflow/src/config-loader.ts |

**Dependencies:** 无

---

#### G2: 命令 + Tool — save 子命令 + 智能路由 + generate tool + 共用函数

**Description:** 新增 save 子命令和 workflow-generate tool，增强 default handler 的路由消息。同时提取 `saveWorkflow()` 和 `deleteWorkflow()` 共用函数供 widget 调用。

**Tasks:** Task 2, Task 3

**Files (预估):** 2 个文件修改

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: high |
| 注入上下文 | Task 2 + Task 3 描述 + spec FR1/FR2/FR3/FR6 全部 + spec Decisions |
| 读取文件 | workflow/src/commands.ts, workflow/src/index.ts, workflow/src/config-loader.ts, workflow/src/state.ts |
| 修改文件 | workflow/src/commands.ts, workflow/src/index.ts |

**Dependencies:** G1（需要 scanWorkflows 返回 source/path）

**Execution Flow (G2 内部):** 串行

  Task 2:
    1. general-purpose → 修改 commands.ts（save 子命令 + 路由增强 + 提取 saveWorkflow/deleteWorkflow 导出函数）

  Task 3:
    1. general-purpose → 修改 index.ts（注册 workflow-generate tool）

---

#### G3: 面板增强 — widget 标签 + 操作

**Description:** UI 展示增强和交互操作。widget 调用 G2 提取的 `saveWorkflow()`/`deleteWorkflow()` 共用函数。

**Tasks:** Task 4

**Files (预估):** 1 个文件修改

**Subagent 配置:**

| 配置项 | 值 |
|--------|---|
| Agent | general-purpose |
| Model | taskComplexity: medium |
| 注入上下文 | Task 4 描述 + spec FR5/FR6 全部 |
| 读取文件 | workflow/src/widget.ts, workflow/src/commands.ts（import 共用函数）, workflow/src/state.ts |
| 修改文件 | workflow/src/widget.ts |

**Dependencies:** G2（需要 saveWorkflow/deleteWorkflow 导出函数）

---

## Dependency Graph & Wave Schedule

```
G1 (基础设施) ──→ G2 (命令+Tool) ──→ G3 (面板)
```

| Wave | Groups | 说明 |
|------|--------|------|
| Wave 1 | G1 | 基础设施，无依赖 |
| Wave 2 | G2 | 依赖 G1；save/delete 共用函数在此提取 |
| Wave 3 | G3 | 依赖 G2 的共用函数导出 |

---

## Spec Metrics Traceability

| Spec 指标 | 采纳状态 | 对应 Task |
|-----------|---------|----------|
| AC1 `/workflow <prompt>` 生成新 workflow | adopted | Task 2 (路由) + Task 3 (generate) |
| AC2 匹配已有 workflow 让用户选择 | adopted | Task 2 (路由) |
| AC3 临时 workflow 写入 .tmp | adopted | Task 3 (generate) |
| AC4 `/workflow save` 移动到 saved | adopted | Task 2 (save) |
| AC5 `/workflow save --as` 重命名保存 | adopted | Task 2 (save) |
| AC6 执行前展示路径等待确认 | adopted | Task 2 (路由消息) + Task 3 (返回路径) |
| AC7 拒绝无 meta 的脚本 | adopted | Task 3 (generate) |
| AC8 保存不影响运行中 Worker | adopted | Task 2 (save 用 rename) |
| AC9 名称冲突返回错误 | adopted | Task 3 (generate) |
| AC10 .tmp 目录自动创建 | adopted | Task 3 (generate) |
| FR4.5 同名去重优先级 | adopted | Task 1 (config-loader) |
| FR6.3 运行中拒绝删除 | adopted | Task 4 (widget) |
