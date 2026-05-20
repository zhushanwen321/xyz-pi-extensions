# xyz-pi-extensions

## 项目概述

Pi coding agent 的自定义扩展集合。当前包含：

- **goal/** — Codex 风格的 `/goal` 命令，持久化目标驱动自主循环，支持 evidence-based 完成和 token/时间预算
- **todo/** — 轻量三态任务清单（pending/in_progress/completed），`/todos` 命令 + `todo` 工具

扩展通过 symlink 安装到 `~/.pi/agent/extensions/<name>` → 源目录。

## 技术栈

- TypeScript（Pi 运行时执行，不独立编译）
- Pi Extension API（`@mariozechner/pi-coding-agent`）
- typebox（参数 schema 定义）
- pi-tui（终端 UI 组件：Text, Container, Spacer, Markdown 等）
- pi-ai（StringEnum 等工具）

**依赖说明**：扩展没有自己的 `node_modules`，所有 `@mariozechner/*` 和 `typebox` 依赖由 Pi 运行时提供。本地开发时 `tsc --noEmit` 通过 `paths` 映射到全局安装的 Pi 包获取类型。

## 架构

```
<extension>/
  index.ts           # 入口，re-export src/index.ts
  package.json       # name + main
  src/
    index.ts         # 扩展工厂函数（export default），注册 tool + command + events
    state.ts         # 数据模型 + 状态机（如果需要）
    templates.ts     # Steering prompt 模板（如果需要）
    widget.ts        # TUI 渲染逻辑（如果需要）
    commands.ts      # 命令参数解析（如果需要）
```

**职责划分原则**：
- `index.ts`（工厂）只做注册胶水，不含业务逻辑
- 状态管理独立为 `state.ts`
- 渲染逻辑独立为 `widget.ts` 或内联 `render*` 函数
- 每个 `pi.on()` 事件处理器保持简短，复杂逻辑提取到命名函数

## 常用命令

```bash
# 类型检查（需要全局安装了 pi）
cd xyz-pi-extensions && npx tsc --noEmit

# 单个扩展类型检查
cd xyz-pi-extensions/goal && npx tsc --noEmit
```

## 关键约束

### 运行环境

- 扩展在 Pi 进程内执行，**不是独立进程**
- 同一进程可能有多个 session。模块级 `let` 变量会被所有 session 共享，必须用闭包或 session_start 重建
- 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）

### Session 隔离

- 状态必须存储在 `session_start` 重建的闭包变量或 `ctx.sessionManager` entries 中
- `todo` 扩展的 `let todos` 是已知的违反——当前单 session 使用不会有问题，但多 session 时需要重构为闭包内状态

### 状态持久化

- 用 `pi.appendEntry(type, data)` 写入，`ctx.sessionManager.getEntries()` 读取
- 自行实现 GC（splice 旧 entries），防止长 session 中 entries 无限积累
- `deserializeState` 必须向后兼容旧格式（字段缺失时给默认值）

### Tool 设计

- 参数用 typebox `Type.Object()` + `StringEnum()` 定义 schema
- `execute` 返回 `{ content: [...], details: {...} }` 结构
- `details` 是 renderResult 的数据来源，不要依赖 content 文本解析
- 错误用 `throw new Error()`，不要返回 `{ content: [{ text: "错误: ..." }] }` 的错误成功模式

### TUI 渲染

- `renderCall` 和 `renderResult` 返回 `new Text(string, 0, 0)`
- 颜色通过 `theme.fg("token", text)` 使用语义 token，不硬编码 ANSI
- 展开/折叠：`options.expanded` 控制显示详细程度

## 代码规范

### TypeScript

- 禁止 `any`，用 `unknown` 或具体类型
- `(entry as any).customType` 这种模式改为类型守卫函数
- import 顺序：Node 内置 → npm 包 → 项目内部

### 行数

- 单文件不超过 1000 行。超过时按职责拆分到 `src/` 下
- 函数不超过 80 行

### 命名

- 扩展入口：`export default function xxxExtension(pi: ExtensionAPI)`
- 状态接口：`XxxRuntimeState`
- 工具参数：`XxxParams`（typebox schema）
- 工具详情：`XxxDetails`（renderResult 数据）

### Git

- 分支命名：`feat/`、`fix/`、`refactor/`、`chore/`
- Commit 信息：英文

## 质量检查

```bash
# 类型检查
npm run typecheck
# 或 npx tsc --noEmit

# ESLint 品味检查（0 error 为通过）
npm run lint

# 自动修复
npm run lint:fix

# 跳过 pre-commit hook
SKIP_LINT=1 git commit -m "..."

# 手动验证（启动 Pi 后）
/goal Fix the typo in README --tokens 10000
/todos
```

### 品味规则（taste-lint）

项目使用自定义 ESLint 插件 `taste-lint`，复用自 llm-simple-router 项目的通用规则：

- `no-explicit-any: error` — 类型即契约
- `prefer-allsettled` — 独立数据源用 `Promise.allSettled`
- `no-silent-catch` — catch 块不能为空或只有 console
- `no-unbounded-while-true` — while(true) 必须有迭代上限
- `no-inline-import-type` — 禁止 `as import(...).Type`
- `max-lines: 1000` / `max-lines-per-function: 300` — 结构先于一切
- `no-magic-numbers` — 语义化命名（0/1/-1 豁免）

规则源文件：`taste-lint/base.mjs` + `taste-lint/rules/`

## 安装新扩展

```bash
# 全局安装
ln -s /path/to/xyz-pi-extensions/<name> ~/.pi/agent/extensions/<name>

# 项目级安装
ln -s /path/to/xyz-pi-extensions/<name> .pi/extensions/<name>
```
