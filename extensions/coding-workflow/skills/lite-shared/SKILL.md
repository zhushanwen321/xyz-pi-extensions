---
name: lite-shared
description: "[internal] Shared reference files for the lite workflow (lite-plan / coding-execute / coding-retrospect). Not invoked directly — sibling lite-* skills resolve paths via ../lite-shared/references/{file}.md. Kept hidden from model invocation."
disable-model-invocation: true
---

# lite-shared（共享参考，不可主动调用）

> **这是一个物理载体 skill，不是可执行工作流。** 不要主动加载、不要 `/skill:lite-shared`。
> 它存在的唯一目的：让 `references/` 目录被 pi 安装（symlink 到 `~/.pi/agent/skills/lite-shared/`），
> 从而使兄弟 skill 通过相对路径 `../lite-shared/references/{file}.md` 能稳定命中本目录文件。
>
> `disable-model-invocation: true` 使本 skill **不进入** system prompt 的 available skills 列表——
> AI 无法主动发现或调用它。但 pi 的发现管道仍会加载它（symlink 安装 + 进 resourceLoader），
> 其 `references/` 子目录随目录级 symlink 天然可达。

## 定位

lite-* 是 full-* 的**轻量化对照**：full 服务"涉及架构决策的复杂需求"（L2/L3，6 步设计循环 + fresh-subagent 审查 + 反哺 + 一致性终检）；lite 服务"不涉及架构改动的小功能开发"（L1，plan + goal + todo + subagent 直连，强制严格测试）。

| 维度 | full-*（重） | lite-*（轻） |
|------|---------------|-------------|
| 适用场景 | 跨子系统/状态机变更/架构决策 | 小功能、单/少模块改动 |
| 设计流程 | 6 步循环 + 追踪 + 审查门 + 反哺 + 终检 | plan.md 单文件（业务目标 + 技术改动点 + Wave + 测试清单） |
| 测试 | test-matrix 重建（⑤） | 强制单测覆盖率≥60% gate + E2E 边界覆盖 |
| 执行编排 | Wave DAG（只装功能 Wave，整体回归归 CW test 阶段） | Wave 并行 subagent + 测试‖review worktree 隔离 |
| 任务追踪 | design_status 状态机 | todo（isVerification）+ goal（方向/预算） |
| 复盘 | coding-closeout 沉淀长期文档 | coding-retrospect 轻量自检清单 |

## 何时升级到 full（范围守门）

coding-execute 启动前 [MANDATORY] 自检。以下任一信号出现 → **停止 lite，建议改用 full 工作流**：

- 需要跨 2 个及以上子系统/模块协调
- 涉及状态机变更、核心数据模型变更、公共 API 契约变更
- 需要架构决策（技术选型、模块边界重新划分、依赖方向调整）
- 改动会影响 3 个以上既有文件的核心逻辑（非测试文件）
- 需要非功能设计（安全/并发/性能/稳定性等 NFR 风险分析）

> 小功能的判定不是"代码行数少"，而是"改动是否触及架构契约"。加一个工具函数是 lite；改一个扩展的状态机是 full。

## 文件清单

| 文件 | 作用 | 何时读 |
|------|------|--------|
| `references/wave-model.md` | Wave 拆分原则（垂直切片、依赖推导、并行组判定） | lite-plan 写 Wave 表前 read |
| `references/test-case-schema.md` | 单测/E2E 用例表格 schema + 可机器判定规范 + 覆盖率 gate | lite-plan 写测试清单前 read |
| `references/subagent-dispatch.md` | implementer/test-runner/code-review 三种 subagent 的 agent 定义模板 + 派发指令 + worktree 隔离编排 | coding-execute 派 subagent 前 read |

## 引用约定（重要）

兄弟 skill（lite-plan / coding-execute / coding-retrospect）引用本目录文件，
**必须用 `../lite-shared/references/{file}.md`** —— 相对路径的解析基准是当前 skill 的 baseDir
（SKILL.md 的 dirname），`../` 跨到兄弟目录 `lite-shared/`。

不要用裸路径 `lite-shared/references/...`：那会解析成 `{当前skill}/lite-shared/...`，安装态下 broken。
