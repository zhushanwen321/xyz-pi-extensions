---
verdict: FAIL
must_fix:
  - id: MF1
    severity: blocker
    title: "changeset 中 @zhushanwen/pi-workflow 2.0 的 BREAKING 描述与实际代码严重不符（5/6 条为假）"
  - id: MF2
    severity: major
    title: "@zhushanwen/pi-workflow 的 major bump（2.0）缺乏真实架构级 breaking 变更支撑，应降级为 minor"
  - id: MF3
    severity: major
    title: "extension-dependencies.json 中 @zhushanwen/pi-workflow 未声明对 @zhushanwen/pi-subagents 的关系，与 changeset 自述的『硬依赖』矛盾"
---

# Monorepo 影响审查 — PR #66 (`feat-subagent-workflow-enhance`)

**审查范围**：`git diff main...HEAD`，174 文件，+28234 / −788
**审查日期**：2026-06-20
**审查焦点**：monorepo 结构、跨包依赖、公共 API、循环依赖、changeset 合规

---

## Summary

本 PR 新增 `@zhushanwen/pi-subagents` 包（进程内 subagent 运行时），并重构了 `@zhushanwen/pi-workflow`。**结构层面基本健康**：无循环依赖、新包注册完整、shared/types stub 齐全（typecheck + lint 全绿）。

**致命问题在 changeset**：`.changeset/feat-subagent-enhance.md` 对 workflow 2.0 的 6 条 BREAKING 描述中，**5 条与实际代码相反**。workflow 仍然是 spawn 子进程架构，没有依赖 subagents，声称被删除的文件全部仍在使用。若以此 changeset 发布，npm 用户读到的 CHANGELOG 将严重误导，且 major bump（1.1.1→2.0）没有真实变更支撑。

subagents 包本身结构正确，可独立发布。

---

## Findings

| ID | 类别 | 严重度 | 位置 | 问题 | 状态 |
|----|------|--------|------|------|------|
| MF1 | breaking-change | blocker | `.changeset/feat-subagent-enhance.md` | workflow BREAKING 描述 5/6 条为假 | 🔴 必修 |
| MF2 | breaking-change | major | `.changeset/feat-subagent-enhance.md` | workflow major bump 缺支撑 | 🔴 必修 |
| MF3 | workspace-dep | major | `extension-dependencies.json` | workflow↔subagents 依赖关系未声明（与 changeset 自述矛盾） | 🔴 必修 |
| OK1 | workspace-dep | — | `extensions/subagents/package.json` | 新包 pi manifest / peerDeps / files 完整正确 | ✅ 通过 |
| OK2 | workspace-dep | — | `extension-dependencies.json` | subagents 注册 + runtime 依赖 structured-output 声明正确 | ✅ 通过 |
| OK3 | circular-dep | — | `extensions/subagents/`, `extensions/workflow/` | subagents ↔ workflow 零 import，无循环依赖 | ✅ 通过 |
| OK4 | public-api | — | `shared/types/mariozechner/index.d.ts` | +143 行精确类型，typecheck EXIT 0，stub 齐全 | ✅ 通过 |
| OK5 | public-api | — | `shared/taste-lint/base.mjs` | no-unsafe-cast 正确注册（import + plugin + rule） | ✅ 通过 |
| OK6 | workspace-dep | — | `pnpm-workspace.yaml` | `extensions/*` glob 自动包含 subagents，无需改 | ✅ 通过 |
| S1 | missing-export | minor | `extensions/unified-hooks/`, `extensions/subagents/` | unified-hooks 与 subagents 各自实现 agent 发现（重复） | 🟡 建议 |
| S2 | breaking-change | minor | `extensions/model-switch/` | model-switch 无 changeset 但属正常（无 breaking，见下） | 🟢 信息 |

---

## 必修项详解

### MF1 — changeset workflow BREAKING 描述与代码不符（blocker）

`.changeset/feat-subagent-enhance.md` 中 `@zhushanwen/pi-workflow` 2.0 章节的逐条核对：

| changeset 声称 | 实际代码（HEAD） | 判定 |
|---|---|---|
| "改用 subagents 进程内执行，移除 spawn 子进程模型" | `extensions/workflow/src/infra/agent-pool.ts:1-12` 注释："Manages a pool of pi --mode json **subprocesses**… Each call **spawns** an isolated pi process"。README（本次新增）："workflow 采用自包含的 `spawn pi --mode json` 子进程架构执行 agent，不依赖任何外部 agent 运行时" | ❌ **完全相反** |
| "新增 `@zhushanwen/pi-subagents` 硬依赖" | `extensions/workflow/package.json`：peerDependencies 无 subagents；`extension-dependencies.json`：workflow.dependsOn 无 subagents；`grep -rn "pi-subagents" extensions/workflow/` → 零命中 | ❌ **不存在** |
| "删除 3 个此前随 files:["src/"] 发布的内部模块（agent-discovery.ts / jsonl-parser.ts / pi-runner.ts）" | `ls extensions/workflow/src/infra/` → 三文件**全部存在**；`orchestrator.ts:16` 仍 `import { AgentRegistry } from "./infra/agent-discovery.js"`；`agent-pool.ts` 仍 import `./pi-runner.js` + `./jsonl-parser.js` | ❌ **未删除** |
| "移除 `cleanupAllTempFiles` / `cleanupTempFile` 导出" | `agent-opts-resolver.ts:112,118` 仍导出；`orchestrator.ts:15,90,92,265,334,453,666,686,698` 大量调用 | ❌ **未移除** |
| "resolveModel 改由 subagents 的 resolveModelForScene() 读取 config.json 的 categories 解析。原 model-switch scene 配置升级后静默失效" | `extensions/workflow/src/engine/model-resolver.ts` 实际退化为 `return opts.model \|\| undefined`，**scene 解析逻辑被完全删除**，既不调 model-switch 也不调 subagents。注释明确："旧的 scene→model 解析（依赖 model-switch / subagents）已删除——workflow 不再承担按 scene 选模型的职责" | ❌ **是删除，不是迁移** |
| "sendCompletionNotification 改为 { triggerTurn: true, deliverAs: 'steer' }，唤醒 parent agent" | `extensions/workflow/src/interface/commands.ts:119` 确实 `}, { triggerTurn: true, deliverAs: "steer" });`，测试 `commands-generate.test.ts:99` 覆盖 | ✅ **真实** |

**影响**：以此 changeset 发布后，CHANGELOG 会告诉用户"workflow 已改用 subagents 进程内执行，请 `pi install @zhushanwen/pi-subagents` 迁移"，但实际 workflow 根本不需要 subagents。用户按指引安装 subagents 后，workflow 也不会用它（仍是 spawn）。这是会引发用户困惑和错误运维的 blocker。

**修复**：重写 `.changeset/feat-subagent-enhance.md` 的 workflow 章节，按实际变更描述：
- resolveModel 删除 scene 解析（**真实 breaking**：使用 `scene` 参数的调用方现在被忽略）
- sendCompletionNotification 默认唤醒 parent（**真实 breaking**：行为变更，默认开启）
- 移除 model-switch peerDependency
- orchestrator 内部重构（spawn 架构不变）

### MF2 — workflow major bump 缺支撑

changeset 标 `"@zhushanwen/pi-workflow": major`（1.1.1 → 2.0.0）。major bump 的理由应是"整体架构变更（spawn → in-process）"，但该变更**未发生**。

真实的 breaking 仅两项局部行为变更（resolveModel scene 删除 + sendCompletionNotification 唤醒），属于 **minor** 范畴（有 breaking 但非架构级）。建议降为 minor，并按 MF1 重写描述。

### MF3 — extension-dependencies.json 依赖关系缺失

**现状矛盾**：
- changeset 自述 workflow 对 subagents 是"硬依赖"
- `extension-dependencies.json` 中 `@zhushanwen/pi-workflow` 的 `dependsOn` **无** subagents 条目（本次还顺带删除了 model-switch 条目）
- workflow package.json 无 subagents 声明

**根因**：workflow 实际上**不依赖** subagents（MF1 已证）。所以 `extension-dependencies.json` 不声明是对的，**错的是 changeset 的描述**。

**修复路径二选一**：
- （推荐，符合实际）保持 `extension-dependencies.json` 不变（workflow 不依赖 subagents），按 MF1 修正 changeset 描述
- （若未来真要 workflow 用 subagents）则在 `extension-dependencies.json` 的 workflow.dependsOn 补 subagents 条目，并在 workflow package.json 补 peerDep，并实现代码切换

---

## 通过项确认

### OK1 — subagents package.json 结构正确
- `pi.extensions: ["./index.ts"]` 符合红线规范（非 `./src/index.ts`）
- `peerDependencies` 全部 `optional: true`（@mariozechner/pi-coding-agent / pi-ai / typebox / pi-tui）
- `dependencies: {}` 空 —— 验证：`grep -rn "from [\"']@zhushanwen/" extensions/subagents/` 零命中，subagents 不 import 任何内部包
- `files` 字段完整覆盖 index.ts / agents/ / mocks/ / config.json / src 各子目录
- `keywords: ["pi-package", ...]` ✓

### OK2 — extension-dependencies.json 注册正确
- subagents 条目已添加，`dependsOn` 声明 structured-output 为 `runtime` 类型
- 验证：subagents 通过 tool 名字符串 `"structured-output"` 引用（`session-runner.ts:41`），**不 import 包**，符合 runtime 类型定义（"代码层不 import"）
- schema 校验：`npx ajv-cli validate` → `extension-dependencies.json valid`

### OK3 — 无循环依赖
- `grep -rn "from.*pi-workflow\|from.*pi-subagents" extensions/subagents/` → 零
- `grep -rn "from.*pi-subagents\|from.*pi-workflow" extensions/workflow/` → 零
- 相对路径 import 互相检查 → 零
- subagents 与 workflow 在代码层完全解耦

### OK4 — shared/types stub 齐全
- +143 行：ExtensionAPI 从 `any` 改为精确 interface（含 on() 重载、registerTool/sendUserMessage/exec 等）；SessionStartEvent / ExtensionHandler<E,R> 泛型 / ResourcesDiscoverEvent 精确化；pi-tui 新增 Box / SelectList / Input / KeybindingsManager / fuzzyFilter
- `npx tsc --noEmit` → **EXIT 0**（全量 typecheck 通过，证明 stub 覆盖所有下游引用）
- Component 从空 class 改为 interface（render/invalidate/handleInput）——下游需确认无 `new Component()` 实例化（typecheck 通过即已验证）

### OK5 — taste-lint no-unsafe-cast 注册正确
- `base.mjs`：`import noUnsafeCast from './rules/no-unsafe-cast.mjs'` + `tastePlugin.rules['no-unsafe-cast']` + `tasteRules['taste/no-unsafe-cast']: 'warn'`
- `@typescript-eslint/no-explicit-any` 由 warn 收紧为 error（与 CLAUDE.md / quality-gates.md 一致）
- 有测试 `shared/taste-lint/__tests__/no-unsafe-cast.test.mjs`
- `pnpm -r lint` → EXIT 0（规则不破坏现有代码）

### OK6 — pnpm-workspace.yaml 无需改
- 使用 `extensions/*` + `shared/*` glob，subagents 自动被 workspace 识别
- `pnpm-lock.yaml` 已更新（+61 行）

---

## 建议项

### S1 — unified-hooks 与 subagents 的 agent 发现重复实现
`extensions/unified-hooks/src/hooks/subagent-list-injector.ts` 自行扫描 .md agent 文件（builtin/user/project scope）注入 system prompt，与 subagents 包的 `agent-registry.ts` 是**两套独立的 agent 发现逻辑**。两者都扫描 `~/.pi/agent/subagents` 等目录。注释 `subagent-list-injector.ts:108` 提到 "Builtin agents from pi-subagents package" 但不 import 该包。

**建议**：长期看应让 unified-hooks 复用 subagents 的 agent-registry（package 依赖），避免发现逻辑漂移。短期可接受重复（unified-hooks 仅读 frontmatter 注入 prompt，subagents 做完整运行时，职责不同）。**不阻塞本次合并**。

### S2 — model-switch 无 changeset（正常）
model-switch 删除了 `extractModelCapabilities` 函数（types.ts）和 `resolveModelForScene` 的 re-export 路径修正（`./advisor` → `./src/advisor.ts`，export 本身保留）。
- `extractModelCapabilities`：grep 确认无外部包引用（仅 model-switch 内部）→ 非 breaking
- `resolveModelForScene` re-export：**仍存在**（`index.ts:1`），路径修正而已
- 结论：model-switch 无 breaking，不配 changeset 是正确的 ✓

---

## 版本 bump 评估汇总

| 包 | changeset | 实际变更 | 评估 |
|----|-----------|---------|------|
| `@zhushanwen/pi-subagents` | minor (0.1.0 首发) | 全新包，进程内 subagent 运行时 | ✅ 合理 |
| `@zhushanwen/pi-workflow` | **major (2.0)** | resolveModel scene 删除 + sendCompletionNotification 唤醒 + 移除 model-switch peerDep + orchestrator 重构（spawn 不变） | ❌ **应降为 minor**，且须按 MF1 重写描述 |
| `@zhushanwen/pi-unified-hooks` | minor | session_start 改 ctx.ui.notify + HookContext 导出 + 测试 | ✅ 合理 |
| `@zhushanwen/pi-taste-lint` | minor | no-unsafe-cast 规则 + no-explicit-any 收紧 | ✅ 合理 |
| `@zhushanwen/pi-model-switch` | （无） | 内部函数删除 + re-export 路径修正，无 breaking | ✅ 无需 bump |

---

## 验证命令记录

```bash
# typecheck（全绿）
npx tsc --noEmit  # EXIT 0

# lint（全绿）
pnpm -r lint  # EXIT 0

# extension-dependencies schema
npx ajv-cli validate -s extension-dependencies.schema.json -d extension-dependencies.json  # valid

# 循环依赖
grep -rn "from.*pi-workflow\|from.*pi-subagents" extensions/subagents/ extensions/workflow/  # 零命中
```
