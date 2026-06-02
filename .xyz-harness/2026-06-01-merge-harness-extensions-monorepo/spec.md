---
verdict: pass
---

# xyz-harness + xyz-pi-extensions 合并为 Monorepo

## Background

两个独立仓库承载了 Pi 生态的不同层级：

| 仓库 | 本质 | 代码规模 |
|------|------|---------|
| **xyz-pi-extensions** | Pi 原生扩展集合（基础能力） | ~6.6k LOC (TS) |
| **xyz-harness-engineering** | 编码工作流引擎（应用层方法论 + 扩展） | ~2k LOC (TS + Python + Markdown) |

问题：
1. 功能重叠（subagent 三处实现、taste-lint 两处维护、todo/todolist 功能重复）
2. 跨仓库改动需要多个 PR
3. 当前 symlink 安装方式不够优雅，无法版本管理
4. 文档分散，维护成本高

目标：整合为一个 monorepo，每个 extension 作为独立 npm 包发布到 `@zhushanwen` scope。

## Functional Requirements

### FR-1: Monorepo 目录结构

将 xyz-pi-extensions 重构为 pnpm workspaces monorepo：

```
xyz-pi-extensions/
├── packages/                    # 所有可发布的 npm 包
│   ├── goal/                → @zhushanwen/pi-goal
│   ├── todo/                → @zhushanwen/pi-todo
│   ├── subagent/            → @zhushanwen/pi-subagent
│   ├── coding-workflow/     → @zhushanwen/pi-coding-workflow
│   ├── claude-rules-loader/ → @zhushanwen/pi-claude-rules-loader
│   ├── context-engineering/ → @zhushanwen/pi-context-engineering
│   ├── skill-state/         → @zhushanwen/pi-skill-state
│   ├── evolve-daily/        → @zhushanwen/pi-evolve-daily
│   ├── statusline/          → @zhushanwen/pi-statusline
│   ├── unified-hooks/       → @zhushanwen/pi-unified-hooks
│   ├── workflow/            → @zhushanwen/pi-workflow
│   ├── taste-lint/          → @zhushanwen/pi-taste-lint
│   └── types/               → @zhushanwen/pi-types (private)
├── skills/                      # 独立 skills（无所属 extension，GitHub 分发）
├── scripts/                     # 共享脚本
├── docs/                        # 统一文档
├── .changeset/                  # 版本管理
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.json
```

### FR-2: 每个 Extension 独立 npm 包

每个 extension 的 `package.json` 更新为：
- `name`: `@zhushanwen/pi-<name>`
- `main`: 入口文件
- `files`: 发布白名单（`src/`、`skills/`、`scripts/` 等）
- 独立版本号
- 必要的 `peerDependencies` 或 `dependencies`

### FR-3: Skills 内嵌到所属 Extension

Extension 通过 Pi 的 `resources_discover` 事件在 `session_start` 时动态注册自带 skills：

**coding-workflow** 内嵌 ~20 个 harness skills：
- `xyz-harness-brainstorming`、`xyz-harness-writing-plans`、`xyz-harness-phase-dev` 等
- `xyz-harness-gate`、`xyz-harness-gate-reviewer`、`xyz-harness-expert-reviewer` 等
- `harness-retrospect`、`harness-retrospect-collector`
- `xyz-harness-test-driven-development`、`xyz-harness-subagent-driven-development` 等
- `xyz-harness-backend-dev`、`xyz-harness-frontend-dev`、`xyz-harness-code-standard-protection` 等

**evolve-daily** 内嵌 evolve skills：
- `evolve`、`evolve-apply`、`evolve-report`

### FR-4: 独立 Skills 保持 GitHub 分发

无所属 extension 的 skills 放在 `skills/` 目录，通过 symlink 或 clone 安装到 `~/.pi/agent/skills/`。完整清单：

**从 harness 迁入的独立 skills：**
- `create-worktree`、`merge-worktree`、`remove-worktree` — worktree 管理
- `code-review-worktree` — 代码审查
- `zcommit` — git commit
- `browser-automation`、`code-link` — 通用工具
- `meta-sk-agent-writer`、`meta-sk-skill-writer` — skill 开发工具
- `vision-analysis` — 图像分析（降级替代）

### FR-5: coding-workflow 消除内部 subagent 重复

coding-workflow 当前内嵌了自己的 subagent 实现。具体涉及的文件和依赖关系：

**coding-workflow/lib/ 内部 subagent 相关文件：**
- `subagent.ts` — spawn pi 进程、JSON streaming、runSubagent() 函数。依赖 `model-resolve.ts`、`process-manager.ts`
- `model-resolve.ts` — 读取 `~/.pi/agent/subagent-models.json`，按 taskComplexity 选模型。导出 `ThinkingLevel`、`THINKING_TO_PI`、`resolveModel()`
- `process-manager.ts` — 进程超时管理、cleanup。导出 `ProcessManager`、`ProcessOpts`、`ProcessResult`

**coding-workflow 引用 subagent 的入口：**
- `index.ts` → 从 `./lib/subagent.js` 导入 `formatUsageStats`
- `lib/review-dispatcher.ts` → 从 `./lib/subagent.js` 导入 `runSubagent`、`SubagentOpts`、`SubagentResult`、`formatUsageStats`；从 `./lib/model-resolve.js` 导入 `resolveModel`、`ThinkingLevel`、`THINKING_TO_PI`

**迁移策略：**
1. `subagent.ts`、`model-resolve.ts`、`process-manager.ts` 的功能与 `@zhushanwen/pi-subagent` 包对比，识别差异
2. 如果 pi-subagent 已覆盖功能 → coding-workflow 删除这 3 个文件，改为 `import { ... } from "@zhushanwen/pi-subagent"`
3. 如果 coding-workflow 有独有功能 → 将其贡献到 pi-subagent 包中，再由 coding-workflow 引用
4. `review-dispatcher.ts` 的 import 路径从 `./lib/subagent.js` 改为 `@zhushanwen/pi-subagent`
5. `index.ts` 的 import 路径从 `./lib/subagent.js` 改为 `@zhushanwen/pi-subagent`

**注意**：此迁移可能改变公共 API（如果 coding-workflow 暴露了 subagent 相关类型）。Phase 2 需在 plan 中详细列出 API 变化。
### FR-6: harness 的 todolist 不迁入

harness 的 `todolist` extension（42334 行单文件）功能与现有 `todo` extension 重叠。**决策：不迁入**，以当前项目的 `todo` 为主。如果后续发现 todolist 有独特功能需要，作为独立需求单独处理，不纳入本次迁移。
### FR-7: harness 的 edit-whitespace-normalizer 删除

此 extension 不再需要，不迁入。

### FR-8: 独立版本管理 + Release Notes

使用 changesets 管理版本：
- `pnpm changeset` 记录变更
- `pnpm changeset version` 更新版本号
- `pnpm changeset publish` 发布到 npm
- Release Notes 自动聚合所有变更的包及其版本变化

### FR-9: 共享类型包

`packages/types/` 作为 private 包（`"private": true`），包含 Pi ExtensionAPI 类型定义。其他包通过 `"@zhushanwen/pi-types": "workspace:*"` 引用。

## Acceptance Criteria

### AC-1: 目录结构
- [ ] 所有 extension 位于 `packages/` 下
- [ ] 独立 skills 位于 `skills/` 下
- [ ] `pnpm-workspace.yaml` 正确配置 `packages/*`
- [ ] `pnpm install` 在根目录成功

### AC-2: npm 包可发布
- [ ] 每个 `packages/` 下的包有正确的 `@zhushanwen/pi-*` name
- [ ] `pnpm changeset publish --dry-run` 不报错
- [ ] coding-workflow 包含 `resources_discover` 事件处理器注册内嵌 skills

### AC-3: 代码迁移
- [ ] coding-workflow 从 harness 仓库完整迁入（含 gate-check.py、lib/ 除 subagent 三文件外）
- [ ] claude-rules-loader 从 harness 仓库迁入
- [ ] harness 的 ~20 个 skills 迁入 `packages/coding-workflow/skills/`
- [ ] evolve 的 3 个 skills 迁入 `packages/evolve-daily/skills/`
- [ ] 独立 skills 迁入 `skills/`（见 FR-4 完整清单）
- [ ] harness 的 agents 迁入 `packages/coding-workflow/agents/`：review-architecture、review-blr、review-dataflow、review-integration、review-robustness、review-standards、review-taste（共 7 个）
- [ ] harness 的 commands 迁入 `packages/coding-workflow/commands/`：dev、track（共 2 个）
- [ ] harness 的文档合并到 `docs/`（adr、research、retrospectives、improvement、harness-design-framework.md 等）

### AC-4: 依赖关系
- [ ] coding-workflow 通过 `workspace:*` 依赖 subagent
- [ ] 所有包通过 `workspace:*` 依赖 types
- [ ] 无循环依赖

### AC-5: 去重
- [ ] coding-workflow 不再有内嵌的 subagent.ts / model-resolve.ts / process-manager.ts
- [ ] coding-workflow 的 review-dispatcher.ts 改为从 @zhushanwen/pi-subagent 导入
- [ ] taste-lint 只保留一份（packages/taste-lint）
- [ ] todolist 不迁入

### AC-6: 类型检查通过
- [ ] `pnpm -r typecheck` 无错误

### AC-7: 功能回归验证
- [ ] 在 Pi 中加载所有已迁移的 extensions（`--extension` 参数），无启动错误
- [ ] coding-workflow 的 gate tool 可执行（调用 `coding-workflow-gate` 无报错）
- [ ] goal 的 `goal_manager` tool 可调用（创建 goal 并完成基础流程）
- [ ] subagent 的 basic single 模式可执行

### AC-8: Harness 仓库归档
- [ ] xyz-harness-engineering 仓库 README 标记为 archived，指向 xyz-pi-extensions

### AC-9: 里程碑检查点
- [ ] **CP-1**: 所有 extension 迁入 `packages/` 后，`pnpm install` + `pnpm -r typecheck` 通过
- [ ] **CP-2**: coding-workflow subagent 去重完成后，功能回归验证通过
- [ ] **CP-3**: skills 迁入后，coding-workflow 的 `resources_discover` 正确注册所有内嵌 skills
- [ ] **CP-4**: 发布配置完成后，`pnpm changeset publish --dry-run` 不报错

## Constraints

1. **npm scope**: `@zhushanwen`（已注册）
2. **工具链**: pnpm workspaces + changesets，不引入 turborepo（无 build 步骤，不需要构建缓存）
3. **Pi 运行时约束**: extensions 在 Pi 进程内执行，不是独立进程，不能依赖 fs 之外的 Node.js 原生模块（subagent 是已知例外）
4. **双模运行**: extensions 必须同时支持 pi TUI 和 xyz-agent GUI 两种模式
5. **Skills 随 owner 走**: 有归属 extension 的 skill 内嵌到 extension 包中，独立 skill 放 `skills/` 目录
6. **Harness 是逻辑概念**: 不存在叫 "harness" 的物理目录，coding-workflow 是与 goal/todo 平级的普通 extension
7. **不改变运行时行为**: 迁移不改变任何 extension 的功能逻辑，只改变代码组织方式

## 业务用例

> 初版简述。

### UC-1: 扩展开发者跨仓库改动
- **Actor**: 项目维护者
- **场景**: 需要修改 subagent 功能（如增加新的 model resolve 策略）
- **预期结果**: 只需修改 `packages/subagent/` 一处代码，coding-workflow 自动通过 workspace 依赖获得更新，不再需要跨仓库提交多个 PR

### UC-2: 用户安装 Pi 扩展
- **Actor**: Pi 用户
- **场景**: 用户想使用 goal 扩展管理项目目标
- **预期结果**: `npm install @zhushanwen/pi-goal` 一条命令完成安装，无需手动创建 symlink，版本可追踪可回退

## Complexity Assessment

**规模**: 大型重构。涉及 2 个仓库、~13 个 extension、~30 个 skill、7 个 agent、2 个 command、共享类型、脚本、文档。

**风险和缓解：**
| 风险 | 概率 | 缓解 |
|------|------|------|
| subagent 去重引入行为差异 | 中 | CP-2 验证 + 对比测试 coding-workflow 的 review dispatch 功能 |
| skill 资源路径变化导致 `resources_discover` 失效 | 低 | CP-3 验证 + 用 `__dirname` 相对定位 |
| gate-check.py 的 Python 路径在 npm 包中不正确 | 中 | gate-check.py 放入 `packages/coding-workflow/scripts/`，通过 `__dirname` 相对定位，纳入 npm `files` 白名单 |
| 大规模目录移动导致 git 历史断裂 | 低 | 合并前在 harness 仓库打 release tag，归档后保留只读状态 |

**Python 脚本管理：**
- `gate-check.py` 放入 `packages/coding-workflow/scripts/`，通过 `__dirname` 相对路径调用
- Python 依赖（PyYAML）在 README 中说明，不纳入 npm 包管理
- 纳入 npm 包的 `files` 白名单确保发布时包含
- `validate-skill-yaml.py` 放入 `scripts/`（共享脚本）

**关键路径**: 目录结构建立(CP-1) → extension 迁移 → subagent 去重(CP-2) → skills 迁入(CP-3) → 发布配置(CP-4) → 归档
