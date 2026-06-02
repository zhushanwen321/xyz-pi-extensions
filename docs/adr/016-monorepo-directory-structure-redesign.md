# 016-monorepo-directory-structure-redesign

> Status: accepted
> Date: 2026-06-02
> Supersedes: 部分 015-three-repo-integration-architecture 中的目录规划

---

## Context

monorepo `packages/` 目录混入了三类东西：
1. Pi 扩展（11 个，核心产品）
2. ESLint 插件（taste-lint，开发工具）
3. 内部共享包（types、quota-providers，非扩展）

项目名叫 `xyz-pi-extensions`，核心是 Pi 扩展。但 `packages/` 这个通用命名让非扩展包混了进来，导致：
- pre-commit hook 需要显式跳过 `taste-lint`
- `types`（CI 类型桩）和 `quota-providers`（内部依赖）与扩展并列，定位模糊
- `scripts/pi-session-analyzer/` 是死代码（实际使用的是 `evolve-daily/analyzer/`）
- `quota-providers` 是 `private: true` 但被 `model-switch` 和 `statusline` 作为 `dependencies` 引用，publish 时会导致用户安装失败

---

## Decision

### 原则 1：核心目录反映项目身份

项目叫什么，核心目录就叫什么。`xyz-pi-extensions` 的核心是 Pi 扩展，主目录应为 `extensions/`，不是 `packages/`。

### 原则 2：按功能归属，不按"有没有 package.json"

包的放置位置由它的功能决定，不是因为它有 package.json 就放进 `packages/`。

| 功能 | 归属目录 | 示例 |
|------|---------|------|
| Pi 扩展（产品） | `extensions/` | goal, todo, vision |
| 开发工具（服务于 githook/CI） | `.githooks/` 或 `tools/` | taste-lint, validate-*.py |
| 内部共享依赖（非扩展） | `shared/` 或内联到使用者 | quota-providers |
| CI 类型桩 | `types/`（根目录） | mariozechner/index.d.ts |
| 独立 skills | `skills/` | evolve, zcommit |
| 共享脚本 | `scripts/` | pi-session-analyzer |
| 文档 | `docs/` | adr, research |

### 原则 3：npm install 必须能跑

扩展作为 npm 包发布，用户通过 `pi install npm:@zhushanwen/pi-xxx` 安装。任何 `dependencies` 中的包必须在 npm 上可获取。`workspace:*` 在 publish 时转为具体版本号——如果被依赖的包是 `private: true` 不发布，使用者的新版本就装不上。

**违规案例**：`model-switch` 和 `statusline` 依赖 `@zhushanwen/pi-quota-providers`（`private: true`）。publish 这两个包时，用户 `pi install` 会因找不到 `quota-providers` 而失败。

**修复方式**：
- 要么 `quota-providers` 去掉 `private: true`，作为正式包发布
- 要么将 `quota-providers` 的逻辑内联到使用者中，消除依赖

### 原则 4：一个功能一个位置，禁止重复

同一份代码不能在 monorepo 里存在两个副本。

**违规案例**：`scripts/pi-session-analyzer/` 和 `packages/evolve-daily/analyzer/` 内容几乎相同。前者是死代码（无任何代码引用），后者是 `evolve-daily` 实际使用的。

**修复方式**：删除 `scripts/pi-session-analyzer/`，只保留 `packages/evolve-daily/analyzer/`。

### 原则 5：githook 相关工具就近放置

服务于 pre-commit hook、CI 检查的工具，应放在 `.githooks/` 或紧邻 `.githooks/` 的 `tools/` 目录。

当前应归入 `.githooks/` 或 `tools/` 的：
- `taste-lint` — ESLint 插件，被 pre-commit hook 使用
- `validate-extensions-yaml.py` — 校验脚本，被 pre-commit hook 触发
- `validate-skill-yaml.py` — 校验脚本，被 pre-commit hook 触发

---

## Consequences

### 目标结构

```
xyz-pi-extensions/
├── extensions/                  # Pi 扩展（核心，占 85%）
│   ├── goal/
│   ├── todo/
│   ├── vision/
│   ├── coding-workflow/
│   ├── evolve-daily/
│   │   └── analyzer/            # evolve-daily 自带的 Python 分析器
│   └── ...
├── shared/                      # 内部共享依赖（非扩展，需评估是否内联）
│   └── quota-providers/         # TODO: 去 private 或内联到 model-switch + statusline
├── tools/                       # 开发工具（服务于 githook/CI）
│   ├── taste-lint/              # ESLint 插件
│   └── validate-extensions-yaml.py
│   └── validate-skill-yaml.py
├── skills/                      # 独立 skills
├── scripts/                     # 独立工具（非 githook 依赖）
├── types/                       # CI 类型桩（根目录，非 packages）
├── docs/
├── .githooks/                   # git hooks
├── .changeset/
├── pnpm-workspace.yaml
└── package.json
```

### 迁移步骤（下次大版本时执行）

1. `packages/` 下的 11 个 Pi 扩展 → `extensions/`
2. `packages/taste-lint/` → `tools/taste-lint/`
3. `packages/types/` → `types/`（根目录）
4. `packages/quota-providers/` → 评估后决定：去 private 发布 或 内联到 model-switch + statusline
5. `scripts/validate-*.py` → `tools/`
6. ~~删除 `scripts/pi-session-analyzer/`（死代码）~~ ✅ 已完成
7. 更新 `pnpm-workspace.yaml`、`tsconfig.json` paths、CI 配置、CLAUDE.md
