# 质量门控与 Git Hooks

> 本文档列出项目的所有质量门控规则，包括 `.githooks/pre-commit` 中执行的检查项，以及手动执行的结构检查脚本。
>
> 最后更新：2026-06-05

---

## 目录

- [1. Pre-commit Hook 检查项](#1-pre-commit-hook-检查项)
- [2. 独立检查脚本](#2-独立检查脚本)
- [3. 阻断级别说明](#3-阻断级别说明)
- [4. 跳过检查的条件](#4-跳过检查的条件)
- [5. 添加新检查项的流程](#5-添加新检查项的流程)

---

## 1. Pre-commit Hook 检查项

Hook 文件：`.githooks/pre-commit`

### 1.1 Pi Manifest 检查（P0 阻断）

**检查内容**：每个 `extensions/*/package.json` 必须包含：

| 检查项 | 要求 |
|--------|------|
| `pi.extensions` | 必须声明，且所有入口文件必须实际存在 |
| `"type": "module"` | 必须存在 |
| `keywords` 含 `"pi-package"` | 必须存在 |

**Rationale**：npm 包方式加载的扩展依赖这三个字段。缺失任何一个都会导致 `pi install` 后扩展静默不加载。

**跳过**：不适用（全量检查，由 `extensions/*/package.json` 匹配）。

### 1.2 Package.json 深度检查（P0 阻断）

**触发条件**：staged 文件包含 `extensions/` 或 `shared/` 下的 `package.json` 变更。

| 检查项 | 要求 |
|--------|------|
| 包名格式 | 匹配 `@zhushanwen/pi-*` |
| `peerDependencies` 含 `@mariozechner/pi-coding-agent` | 必须存在 |
| `files` 包含入口 `.ts` | 入口文件必须在 `files` 字段中 |

**Rationale**：包名不符约定会导致 npm publish 后不可发现。`files` 不包含入口导致 `npm pack` 后丢失代码。核心 peerDep 缺失导致运行时类型不匹配。

### 1.3 Scripts 校验（P0 阻断）

**触发条件**：staged 文件包含对应文件。

| 脚本 | 触发文件 | 用途 |
|------|---------|------|
| `python3 .githooks/validate-extensions-yaml` | `docs/third-party-extensions/extensions.yaml` | YAML schema 校验 |
| `python3 .githooks/validate-skill-yaml` | `SKILL.md` 文件 | YAML frontmatter 格式校验 |

### 1.4 TypeScript 类型检查（P0 阻断）

**命令**：`npx tsc --noEmit`

**Rationale**：类型错误表示代码有逻辑问题，不允许提交到仓库。

**原则**：全量修复，不接受"不是本次引入"作为跳过理由。修复时从 `shared/types/mariozechner/index.d.ts` 的 stub 开始检查。

### 1.5 ESLint 品味检查（P0 阻断）

**命令**：`npx eslint <staged .ts 文件>`

**规则来源**：`shared/taste-lint/base.mjs` + `shared/taste-lint/rules/`

| 规则 | 级别 |
|------|------|
| `no-explicit-any: error` | **P0** — 类型即契约 |
| `prefer-allsettled` | P1 — 独立数据源用 allSettled |
| `no-silent-catch` | P1 — catch 不能为空 |
| `no-unbounded-while-true` | P0 — while(true) 必须有迭代上限 |
| `no-inline-import-type` | P1 — 禁止内联 import 类型 |
| `max-lines: 1000` | P1 — 单文件行数上限 |
| `max-lines-per-function: 300` | P1 — 函数行数上限 |
| `no-magic-numbers` | P2 — 语义化命名（0/1/-1 豁免） |

### 1.6 单元测试（P0 阻断，按需触发）

**触发条件**：staged `.ts` 文件所在的包存在 `src/__tests__/` 目录。

**命令**：`npx vitest run`

**Rationale**：改动代码的包的测试必须仍然通过。

---

## 2. 独立检查脚本

> **目录约定**：`.githooks/` 存放所有 gate/intercept 类脚本（含 hook 入口和校验工具），`scripts/` 存放项目运维脚本（如 `publish.sh`）。
> 所有 gate 脚本已迁移到 `.githooks/`，人可直接调用（如 `python3 .githooks/validate-extensions-yaml`）。详见 `CLAUDE.md` 的「脚本与 Git Hooks 目录约定」。

### 2.1 `.githooks/check-structure`

手动执行，检查以下项目（不阻断 commit，但 CI 可以开启）：

| 检查项 | 说明 |
|--------|------|
| 扩展入口文件存在 | 验证所有 `pi.extensions` 声明的入口文件 |
| CLAUDE.md 目录同步 | extensions/ 目录变化时验证 CLAUDE.md 的目录结构章节同步 |
| 文件行数上限 | >500 行警告，>1000 行错误 |
| 入口模式检查 | 验证扩展入口有 `export default function` 模式 |
| 模块级变量检查 | 禁止 `let`/`var` 在工厂函数外部 |

### 2.2 `.githooks/validate-extensions-yaml`

校验 `docs/third-party-extensions/extensions.yaml` 符合 JSON Schema。

### 2.3 `.githooks/validate-skill-yaml`

校验 `SKILL.md` 文件的 YAML frontmatter 格式。

---

## 3. 阻断级别说明

| 级别 | 含义 | Pre-commit 行为 |
|------|------|----------------|
| **P0 阻断** | 必须通过，否则拒绝提交 | `exit 1` |
| **P1 警告** | 应修复，但不阻断 | 打印警告，`exit 0` |
| **P2 建议** | 推荐规范，非强制 | 仅在 CI 中展示 |

---

## 4. 跳过检查的条件

| 条件 | 方式 |
|------|------|
| 紧急 hotfix 需要立即提交 | `SKIP_LINT=1 git commit -m "..."` |
| Rebase 进行中 | 自动检测 `rebase-merge` 目录，跳过 |

**警告**：`SKIP_LINT=1` 仅允许在紧急 hotfix 场景使用，且后续必须立即修复所有检查问题。禁止 `--no-verify` 绕过 git hook。

---

## 5. 添加新检查项的流程

1. 在 `.githooks/pre-commit` 中添加检查逻辑
2. 在本文件中记录检查项、级别和 Rationale
3. 如果是独立脚本，放在 `.githooks/` 目录下（gate 类）或 `scripts/` 下（运维类）
4. 更新 CI 配置（`.github/workflows/`）使其在 PR 中也运行
5. 通知团队成员

**设计原则**：
- Pre-commit hook 的总运行时间应控制在 5 秒以内（不含按需触发的 vitest）
- 全量检查优于仅检查 staged 文件（防止历史问题被忽略）
- 阻断策略优先于警告策略（让问题在 commit 前暴露，不积累技术债）
