# Monorepo 约定与结构规范

> 本文档定义 xyz-pi-extensions monorepo 的目录结构、命名约定和模块组织规则。
>
> 最后更新：2026-06-05

---

## 目录

- [1. 顶层目录结构](#1-顶层目录结构)
- [2. 扩展目录结构](#2-扩展目录结构)
- [3. 命名约定](#3-命名约定)
- [4. 包依赖规则](#4-包依赖规则)
- [5. 文件组织规则](#5-文件组织规则)
- [6. 发布规则](#6-发布规则)

---

## 1. 顶层目录结构

```
xyz-pi-extensions/           ← monorepo 根目录
├── extensions/               ← **[强制]** Pi 扩展（可发布的 npm 包）
│   ├── goal/             → @zhushanwen/pi-goal
│   ├── todo/             → @zhushanwen/pi-todo
│   └── ...
├── shared/                    ← **[强制]** 内部共享依赖（不面向终端用户）
│   ├── quota-providers/  → @zhushanwen/pi-quota-providers
│   ├── taste-lint/       → @zhushanwen/pi-taste-lint
│   └── types/            → @zhushanwen/pi-types (private)
├── skills/                    ← 独立 skills（无所属 extension，GitHub 分发）
├── scripts/                   ← 共享脚本（不与特定包绑定）
├── docs/                      ← 统一文档
│   ├── adr/               → 架构决策记录（不可逆）
│   ├── evolution/         → 架构演进与 brainstorming
│   ├── research/          → 外部调研报告
│   ├── analysis/          → 特定问题分析
│   └── improvement/       → 改进方案
├── .changeset/                ← 版本管理
├── .githooks/                 ← Git hooks
├── pnpm-workspace.yaml
└── package.json
```

### 1.1 目录归属原则

| 功能 | 归属目录 | 判定标准 |
|------|---------|---------|
| Pi 扩展（产品） | `extensions/` | 有独立 npm 发布需求，`private:true` 为 `false` |
| 内部共享依赖 | `shared/` | 被多个 `extensions/` 引用，可 private 或 public |
| 独立 skills | `skills/` | 无代码逻辑，纯 Markdown，GitHub 分发 |
| 共享脚本 | `scripts/` | 不与特定包绑定，跨包使用 |
| 项目文档 | `docs/` | 设计文档、分析报告、规范文档 |

**硬性约束**：
- 一个功能一个位置：禁止同一份代码在 monorepo 中存在两个副本
- 新建 Pi 扩展必须放 `extensions/` 目录
- 新增/删除/重命名 extension 后必须同步更新 `CLAUDE.md` 的目录结构

---

## 2. 扩展目录结构

### 2.1 标准结构

```
extensions/<name>/
├── index.ts            # **[强制]** 入口点 re-export: `export { default } from "./src/index.ts"`
├── package.json        # **[强制]** 独立 npm 包声明
├── src/
│   ├── index.ts        # **[强制]** 工厂函数 `export default function(pi: ExtensionAPI)`
│   ├── types.ts        # [推荐] 类型定义、TypeBox schema、常量
│   ├── state.ts        # [推荐] 状态管理（有状态时强制）
│   ├── config.ts       # 配置加载/保存（有配置时强制）
│   ├── templates.ts    # Steering prompt 模板（有时强制）
│   └── __tests__/      # [推荐] 测试文件
│       └── *.test.ts
├── skills/             # [可选] 内嵌 skills
│   └── <name>/SKILL.md
├── scripts/            # [可选] 扩展专用脚本
├── vitest.config.ts    # [推荐] 测试配置（有测试时强制）
├── README.md           # [推荐] 安装与使用说明
└── CHANGELOG.md
```

### 2.2 两种入口模式

**简单扩展**（1-3 个 Tool，<200 行）：
```
extensions/simple-ext/
├── index.ts            # 直接 default export factory
└── package.json
```

**复杂扩展**（多 Tool/Command/Event）：
```
extensions/complex-ext/
├── index.ts            # re-export (1 行)
├── src/
│   ├── index.ts        # factory（注册胶水，不含业务逻辑）
│   ├── types.ts
│   ├── state.ts
│   └── ...
└── package.json
```

### 2.3 shared 包结构

```
shared/<name>/
├── src/
│   ├── index.ts        # 入口
│   └── __tests__/
├── package.json        # private: true 或 public
└── vitest.config.ts
```

---

## 3. 命名约定

### 3.1 包名

| 类型 | 格式 | 示例 |
|------|------|------|
| Extension（可发布） | `@zhushanwen/pi-<name>` | `@zhushanwen/pi-goal` |
| Shared（private） | `@zhushanwen/pi-<name>` + `"private": true` | `@zhushanwen/pi-types` |
| Shared（可发布） | `@zhushanwen/pi-<name>` | `@zhushanwen/pi-taste-lint` |

### 3.2 代码命名

| 元素 | 约定 | 示例 |
|------|------|------|
| 扩展工厂函数 | `xxxExtension(pi: ExtensionAPI)` | `goalExtension(pi)` |
| 状态接口 | `XxxRuntimeState` | `GoalRuntimeState` |
| 工具参数 | `XxxParams` (TypeBox) | `GoalParams` |
| 工具详情 | `XxxDetails` (renderResult 数据) | `GoalDetails` |
| 工具名（Tool name） | `snake_case` | `goal_manager`、`todos` |
| 命令名（Command name） | `kebab-case` | `my-command` |
| 类型文件 | `types.ts` | 集中所有类型定义 |
| Widget key 常量 | `UPPER_SNAKE_CASE` | `GOAL_WIDGET_KEY` |
| 事件名常量 | `UPPER_SNAKE_CASE` | `GOAL_STALL_EVENT` |

### 3.3 Git

| 用途 | 约定 | 示例 |
|------|------|------|
| 功能分支 | `feat/<description>` | `feat/context-compression` |
| 修复分支 | `fix/<description>` | `fix/stale-context-crash` |
| 重构分支 | `refactor/<description>` | `refactor/goal-state-machine` |
| 杂项分支 | `chore/<description>` | `chore/update-deps` |
| Commit 信息 | 英文，使用 conventional commits | `feat(goal): add stall detection` |

---

## 4. 包依赖规则

### 4.1 依赖方向

```
extensions/* ──→ shared/* ──→ 外部 (vitest, typebox, ...)
    │               │
    └─── Pi SDK (peerDeps) ────┘
```

**规则**：
- `extensions/*` 可以引用 `shared/*`（通过 `workspace:*`）
- `shared/*` 不引用 `extensions/*`（防止循环依赖）
- `shared/*` 之间可以相互引用
- Pi SDK 始终通过 `peerDependencies` 声明

### 4.2 依赖类型决策

| 场景 | 声明方式 | 示例 |
|------|---------|------|
| Pi SDK 包 | `peerDependencies` | `@mariozechner/pi-coding-agent` |
| 条件 Pi SDK 包 | `peerDependencies` + `peerDependenciesMeta.optional` | `@earendil-works/pi-tui` |
| monorepo 内部包 | `dependencies` + `"workspace:*"` | `@zhushanwen/pi-quota-providers` |
| 业务逻辑依赖 | `dependencies` | `zod`、`diff` |
| 测试/构建依赖 | `devDependencies` | `vitest`、`typescript` |

---

## 5. 文件组织规则

### 5.1 行数限制

| 约束 | 级别 | 说明 |
|------|------|------|
| 单文件 ≤ 1000 行 | P0（ESLint） | `max-lines: 1000` |
| 单函数 ≤ 300 行 | P1（ESLint） | `max-lines-per-function: 300` |
| 单文件 ≤ 500 行 | P2（指南） | 复杂文件拆分为多模块 |
| 单函数 ≤ 80 行 | P2（指南） | 大函数提取子函数 |
| 事件处理器 ≤ 20 行 | P2（指南） | 复杂逻辑提取命名函数 |

### 5.2 Import 顺序

```typescript
// 1. Node.js 内置模块
import * as fs from "node:fs";
import * as path from "node:path";

// 2. npm 包
import { Type } from "typebox";

// 3. Pi SDK 包
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// 4. monorepo 内部包
import { loadConfig } from "@zhushanwen/pi-quota-providers";

// 5. 当前包内部模块
import { createInitialState } from "./state.ts";
import { MyParams } from "./types.ts";
```

### 5.3 禁止模式

| 禁止 | 替代 |
|------|------|
| `import { ... } from "../"` （上穿包边界） | 明确的子路径 import |
| `require()` （CJS） | ESM `import` |
| 相对路径依赖 `shared/` 包 | `workspace:*` + 包名 |
| 硬编码绝对路径 | `homedir()` / `import.meta.url` + `path.join()` |

---

## 6. 发布规则

### 6.1 版本管理

| 平台 | 工具 | 说��� |
|------|------|------|
| monorepo 整体 | changesets | 各包独立版本号 |
| npm registry | `@zhushanwen/pi-*` | 通过 GitHub Actions 发布 |

### 6.2 版本 bump 规则

| 变更类型 | Bump | 示例 |
|----------|------|------|
| Bug 修复、修正 | `patch` | `0.4.0` → `0.4.1` |
| 新功能、新 API | `minor` | `0.4.0` → `0.5.0` |
| 破坏性变更 | `major` | `0.4.0` → `1.0.0` |

### 6.3 发布禁令

| 禁止 | 原因 |
|------|------|
| 本地 `npm publish` | 必须走 GitHub Actions |
| `--no-verify` git commit | 绕过质量门控 |
| `private: true` 的包作为 `dependencies` | npm install 无法解析 |

### 6.4 Prerelease 流程

`dev-*` 分支支持 prerelease 发布：

```
main（正式发布）         dev-0.2.0（prerelease）
├── tag v* 触发           ├── push 触发
├── npm tag: latest       ├── npm tag: dev
├── 版本: 0.1.0           └── 版本: 0.2.0-dev.0
└── changeset 自动 bump
```
