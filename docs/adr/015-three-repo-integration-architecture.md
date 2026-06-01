# ADR-0008：三仓库整合架构

> 日期：2026-06-01
> 状态：Proposed
> 关联：xyz-harness-engineering、xyz-pi-extensions、xyz-agent

---

## 背景

三个独立仓库承载了 AI 编码工作流的不同层级：

| 仓库 | 本质 | 代码规模 |
|------|------|---------|
| **xyz-agent** | Electron GUI 桌面应用，pi 作为 sidecar | ~45k LOC (TS + Vue) |
| **xyz-pi-extensions** | Pi 原生扩展集合（平台基础能力） | ~6.6k LOC (TS) |
| **xyz-harness-engineering** | 编码工作流引擎（应用层方法论 + 扩展） | ~2k LOC (TS + Python + Markdown) |

三个仓库由同一人维护，存在功能重叠、数据分散、维护成本分散的问题。本文档分析整合的必要性、目标架构和迁移策略。

---

## 一、三仓库现状定位

### 1.1 xyz-agent — GUI 平台

**定位**：基于 Electron + Vue 3 的 AI Agent 桌面工作台，pi 作为 sidecar 通过 RPC 驱动。

**核心能力**：

| 能力 | 实现 | 说明 |
|------|------|------|
| 多 Session 管理 | ProcessManager + SessionPool | 每个 session 独立 pi 进程 |
| Plugin 系统 | Worker Thread 隔离，PluginService | `~/.xyz-agent/plugins/`，支持 UI 扩展 |
| Extension 管理 | ExtensionService | `~/.xyz-agent/extensions/`，传给 pi `--extension` |
| GUI | Vue 3 + xyz-ui 组件库 | 聊天、Settings、Session Tree |
| 打包分发 | electron-builder | DMG/ZIP/EXE，内嵌 pi 二进制 |

**关键架构约束**：

```
xyz-agent (Electron)
  → ProcessManager.spawn() → pi --mode rpc --no-extensions
    → --extension <path> (从 ~/.xyz-agent/extensions/ 发现)
    → PI_CODING_AGENT_DIR = ~/.xyz-agent/pi/agent/
```

xyz-agent 启动 pi 时用 `--no-extensions` 禁用 pi 原生扩展加载，再通过 `--extension` 选择性注入。使用独立的 agent 目录（`~/.xyz-agent/pi/agent/`），与系统 pi 的 `~/.pi/agent/` 完全隔离。

**两套扩展机制并存**：

| 机制 | 运行环境 | API | 用途 |
|------|---------|-----|------|
| xyz-agent Plugin | Worker Thread | `agent.*`, `session.*`, `ui.*` | GUI 专属功能（statusBar、panels） |
| Pi Extension | pi 主进程 | `pi.on()`, `pi.registerTool()` | Agent loop 钩子（工具注册、事件拦截） |

两者解决不同问题，不能互相替代。

### 1.2 xyz-pi-extensions — 平台基础能力

**定位**：Pi 原生 ExtensionAPI 扩展集合，为 pi TUI 和 GUI 提供通用基础能力。

**当前组件**：

| 扩展 | 职责 | 自闭环程度 |
|------|------|-----------|
| **workflow** | 通用 DAG 执行引擎（Worker 线程、callCache、budget） | 高（pause/resume/retry） |
| **context-engineering** | 上下文管理（frozen-fresh、recall-store、compressor） | 高（自动压缩 + 召回） |
| **skill-state** | Skill 加载/执行/异常状态追踪 | 高（状态机 + 阈值告警） |
| **evolve-daily** | 会话数据采集，自动生成 daily report | 高（session_start 自动触发） |
| **goal** | 目标模式任务管理 | 中（依赖 AI 交互） |
| **todo** | 轻量级任务清单 | 中（依赖 AI 交互） |
| **subagent** | Subagent 管理（通用化） | 中 |
| **unified-hooks** | Hook 管理 | 中 |
| **taste-lint** | 代码品味 lint | 高（自动检测） |

**共同特征**：
- 使用 Pi ExtensionAPI（`pi.on()`, `pi.registerTool()`, `pi.sendUserMessage()` 等）
- 与宿主无关——不关心运行在 pi TUI 还是 xyz-agent GUI
- 数据目录：`~/.pi/agent/`（TUI 模式）或 `~/.xyz-agent/pi/agent/`（GUI 模式）

### 1.3 xyz-harness-engineering — 编码工作流引擎

**定位**：基于 5-Phase 线性流水线的 AI 编码工作流引擎，包含编码方法论（skills）和运行时扩展。

**核心组件**：

| 组件 | 类型 | 说明 |
|------|------|------|
| **coding-workflow** extension | Pi Extension | 5-Phase 编排、Gate 检查、Review 派遣、复盘触发 |
| **11 个 harness skills** | SKILL.md | Spec/Plan/Dev/Test/PR 方法论 + Gate/Review/Retrospect 方法论 |
| **gate-check.py** | Python 脚本 | GL1 脚本门禁（文件存在性 + YAML frontmatter） |
| **collect.py** | Python 脚本 | 复盘文件扫描 + 吸收追踪 |
| **六维度评估框架** | 文档 | Harness 设计方法论（上下文/工具/编排/状态/评估/约束） |
| **调研文档** | 文档 | Claude Code / Codex / Devin 等成熟系统分析 |

**Harness 的五层防御体系**：

```
L1 上下文隔离 ── Phase 间 compact，信息不跨 Phase
L2 脚本门禁 ──── gate-check.py，AI 无法伪造
L3 独立评审 ──── Review Subagent，不继承主 agent 上下文
L4 强制复盘 ──── Retrospect，phase-start 检查 frontmatter
L5 结果可见 ──── Gate PASS 消息包含 review + retrospect 状态
```

**当前复盘闭环的问题**：

```
gate PASS → steer 触发主 agent 写复盘 → retrospect.md (absorbed: false)
  → ... 停在这里。harness-retrospect-collector 是手动 skill，需要维护者定期操作。
```

复盘产出的 `harness_issues` 没有自动反馈到 harness 代码本身。

---

## 二、重叠分析

### 2.1 功能重叠

| 功能域 | xyz-agent | xyz-pi-extensions | xyz-harness | 重叠程度 |
|--------|----------|-------------------|-------------|---------|
| 工作流编排 | — | workflow (通用引擎) | coding-workflow (5-Phase) | 部分 |
| 状态追踪 | — | skill-state | coding-workflow 内部 state | 概念 |
| 上下文管理 | — | context-engineering | compact + before_agent_start | 部分 |
| Subagent | — | subagent | subagent.ts | 实现 |
| 代码品味 | — | taste-lint | taste-lint (skills/) | 完全 |
| 进化系统 | — | evolve-daily + evolve skills | — | 无 |
| 复盘系统 | — | — | harness-retrospect + collector | 无 |
| GUI | Electron + Vue | — | — | 无 |
| Plugin 系统 | Worker Thread | — | — | 无 |

### 2.2 三处 Subagent 实现

| 位置 | 实现方式 | 用途 |
|------|---------|------|
| xyz-pi-extensions/subagent | 独立扩展 | 通用 subagent 管理 |
| xyz-harness/coding-workflow/lib/subagent.ts | 内嵌 | Gate Review subagent 派遣 |
| xyz-harness/coding-workflow/lib/model-resolve.ts | 内嵌 | 按 complexity 选模型 |

三个地方各自实现了 spawn + JSON streaming + model resolve。应统一为一处。

### 2.3 两处 taste-lint

| 位置 | 形式 |
|------|------|
| xyz-pi-extensions/taste-lint | Pi Extension |
| xyz-harness-engineering/skills/ | SKILL.md |

Extension 是运行时自动检测，Skill 是 AI 按方法论审查。两者互补但代码独立维护。

---

## 三、整合目标

### 3.1 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│                     xyz-agent (平台)                         │
│  Electron GUI + Sidecar Runtime + Plugin System              │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              extensions/ (基础能力层)                  │   │
│  │  workflow · context-engineering · skill-state          │   │
│  │  evolve-daily · goal · todo · subagent · taste-lint    │   │
│  │  coding-workflow                                       │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              skills/ (应用层方法论)                    │   │
│  │  xyz-harness-brainstorming · xyz-harness-writing-plans │   │
│  │  xyz-harness-phase-dev · xyz-harness-phase-test        │   │
│  │  xyz-harness-phase-pr · xyz-harness-gate               │   │
│  │  xyz-harness-gate-reviewer · xyz-harness-expert-reviewer│   │
│  │  harness-retrospect · harness-retrospect-collector      │   │
│  │  evolve · evolve-apply · evolve-report                  │   │
│  │  ... (其他通用 skills)                                  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │              scripts/ (共享脚本)                       │   │
│  │  gate-check.py · collect.py · analyze.py               │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 各层职责边界

| 层 | 职责 | 技术栈 | 变更频率 |
|----|------|--------|---------|
| **平台层** (xyz-agent app) | GUI、Session 管理、Plugin 系统、打包分发 | Electron + Vue + TS | 高（功能迭代） |
| **基础能力层** (extensions/) | Agent loop 钩子、通用工具、状态管理 | Pi ExtensionAPI (TS) | 中（稳定性优先） |
| **应用层** (skills/) | 编码方法论、审查流程、复盘机制 | Markdown (SKILL.md) | 中（方法论迭代） |
| **脚本层** (scripts/) | 确定性验证、数据处理 | Python | 低（稳定后少改） |

### 3.3 组件关系图

```
用户
  │
  ├── pi TUI ─────────────────────────────────────────┐
  │     │                                              │
  │     ├── extensions/skill-state ←── tool_call hook  │
  │     ├── extensions/evolve-daily ←── session_start  │
  │     ├── extensions/coding-workflow                 │
  │     │     ├── before_agent_start → 注入 skill      │
  │     │     ├── registerTool(gate) → gate-check.py   │
  │     │     ├── registerTool(phase-start) → compact  │
  │     │     └── dispatchReviewSubagent → subagent    │
  │     ├── extensions/context-engineering             │
  │     │     └── frozen-fresh + recall-store          │
  │     └── skills/* (AI 按需 read)                    │
  │                                                    │
  └── xyz-agent GUI ──────────────────────────────────┐
        │                                              │
        ├── Electron Main                              │
        │     ├── ProcessManager → pi --mode rpc       │
        │     ├── ExtensionService → --extension 注入   │
        │     └── PluginService (Worker Thread)        │
        │           └── GUI plugins (statusBar等)       │
        │                                              │
        ├── Sidecar Runtime                            │
        │     ├── server.ts (WebSocket)                │
        │     ├── EventAdapter (pi → WS 转换)           │
        │     └── SessionService                       │
        │                                              │
        └── Vue Renderer                               │
              ├── ChatView                             │
              ├── SessionTree                          │
              └── Settings                             │
```

**关键点**：extensions 和 skills 在两种模式下完全共用。差异仅在宿主进程不同（pi 独立 vs pi sidecar），扩展代码本身无感知。

---

## 四、整合方案

### 4.1 目标目录结构

```
xyz-agent-workspace/
├── src-electron/                    # 平台层：Electron 应用
│   ├── main/                        # Electron 主进程
│   ├── preload/                     # 安全桥接
│   ├── renderer/                    # Vue 3 前端
│   ├── runtime/                     # Sidecar + Plugin 系统
│   └── shared/                      # 前后端共享类型
│
├── extensions/                      # 基础能力层：Pi Extensions
│   ├── coding-workflow/             # 5-Phase 编码工作流（从 harness 迁入）
│   │   ├── index.ts
│   │   ├── gate-check.py
│   │   └── lib/
│   │       ├── gate-runner.ts
│   │       ├── review-dispatcher.ts
│   │       ├── skill-resolver.ts
│   │       ├── model-resolve.ts
│   │       └── subagent.ts         # → 改为引用 shared/subagent
│   ├── context-engineering/         # 上下文管理（从 pi-extensions 迁入）
│   ├── skill-state/                 # Skill 状态追踪（从 pi-extensions 迁入）
│   ├── evolve-daily/                # 进化数据采集（从 pi-extensions 迁入）
│   ├── workflow/                    # 通用执行引擎（从 pi-extensions 迁入）
│   ├── goal/                        # 目标管理（从 pi-extensions 迁入）
│   ├── todo/                        # Todo 追踪（从 pi-extensions 迁入）
│   ├── subagent/                    # Subagent 管理（从 pi-extensions 迁入，统一实现）
│   ├── unified-hooks/               # Hook 管理（从 pi-extensions 迁入）
│   └── taste-lint/                  # 代码品味 lint（从 pi-extensions 迁入）
│
├── skills/                          # 应用层：Skills（方法论）
│   ├── xyz-harness-brainstorming/   # Phase 1: Spec
│   ├── xyz-harness-writing-plans/   # Phase 2: Plan
│   ├── xyz-harness-phase-dev/       # Phase 3: Dev
│   ├── xyz-harness-phase-test/      # Phase 4: Test
│   ├── xyz-harness-phase-pr/        # Phase 5: PR
│   ├── xyz-harness-gate/            # Gate 验证方法论
│   ├── xyz-harness-gate-reviewer/   # 防伪造审查方法论
│   ├── xyz-harness-expert-reviewer/ # 内容质量审查方法论
│   ├── xyz-harness-backend-dev/     # 后端编码规范
│   ├── xyz-harness-frontend-dev/    # 前端编码规范
│   ├── xyz-harness-test-driven-development/
│   ├── xyz-harness-subagent-driven-development/
│   ├── xyz-harness-code-standard-protection/
│   ├── xyz-harness-business-logic-reviewer/
│   ├── xyz-harness-integration-reviewer/
│   ├── xyz-harness-robustness-reviewer/
│   ├── xyz-harness-standards-reviewer/
│   ├── harness-retrospect/          # 复盘方法论
│   ├── harness-retrospect-collector/ # 复盘收集（增强：对接 evolve）
│   ├── evolve/                      # 进化分析
│   ├── evolve-apply/                # 进化应用
│   ├── evolve-report/               # 进化报告
│   └── ...                          # 其他通用 skills
│
├── scripts/                         # 共享脚本
│   ├── gate-check.py                # GL1 脚本门禁
│   ├── collect.py                   # 复盘收集
│   ├── analyze.py                   # 会话分析
│   └── validate-skill-yaml.py       # Skill YAML 校验
│
├── packages/                        # 可独立发布的包
│   ├── plugin-sdk/                  # Plugin SDK（已有）
│   └── create-xyz-plugin/           # Plugin 脚手架（已有）
│
├── docs/                            # 统一文档
│   ├── CONTEXT.md                   # 核心术语表
│   ├── adr/                         # 架构决策记录
│   ├── research/                    # 业界调研
│   ├── standards.md                 # 编码规范
│   ├── design-system.md             # 设计系统
│   └── feature-map/                 # 功能地图
│
├── taste-lint/                      # ESLint 品味规则
├── tools/                           # 开发工具
├── scripts/                         # 构建脚本
├── pnpm-workspace.yaml
├── package.json
├── CLAUDE.md
├── CONTEXT.md
└── DESIGN.md
```

### 4.2 复盘闭环增强

整合后，retrospect → evolve 的闭环自然打通：

```
现状（断裂）:
  harness_issues → 写入 retrospect.md → 等人手动 absorb → (无人操作)

整合后（闭环）:
  harness_issues → 写入 retrospect.md
    → evolve-daily 扫描 .xyz-harness/*/changes/reviews/*_retrospect.md
    → 聚合到 daily-reports JSON
    → /evolve 分析时作为 harness 维度数据源
    → 产出针对 extensions/coding-workflow 和 skills/xyz-harness-* 的 suggestions
    → /evolve-apply 修改 harness 代码
    → 自动标记 retrospect absorbed: true
```

**具体改动**：

1. **evolve-daily**：session_start 时除跑 `analyze.py` 外，增加 retrospect 文件扫描
2. **evolve skill**：增加 `harness` 分析维度，交叉引用 gate retry 数据和 harness_issues
3. **evolve-apply**：修改 harness 相关文件后，调用 `collect.py --absorb` 自动标记

### 4.3 Subagent 统一

将三处 subagent 实现统一到 `extensions/subagent/`：

```
extensions/subagent/
├── index.ts              # Pi Extension 入口
├── spawn.ts              # 统一的 spawn + JSON streaming
├── model-resolve.ts      # 按 taskComplexity 选模型（合并 coding-workflow 的实现）
└── process-registry.ts   # 进程管理（cleanup、timeout）
```

`coding-workflow/lib/subagent.ts` 和 `coding-workflow/lib/model-resolve.ts` 改为引用 `extensions/subagent/` 的共享实现。

---

## 五、兼容性约束

### 5.1 双模运行

所有 extensions 必须同时支持两种运行模式：

| 模式 | 宿主 | 扩展加载方式 | 数据目录 |
|------|------|-------------|---------|
| **TUI** | pi 独立进程 | `~/.pi/agent/extensions/` 自动发现 | `~/.pi/agent/` |
| **GUI** | pi sidecar (xyz-agent) | `~/.xyz-agent/extensions/` → `--extension` 注入 | `~/.xyz-agent/pi/agent/` |

**约束**：extensions 代码中不得引用任何 Electron/Vue/GUI 代码。只能使用 Pi ExtensionAPI。

### 5.2 Skills 便携性

Skills 是纯 Markdown 文件，通过 `read` 工具加载。两种模式下都可用：

| 模式 | Skills 来源 |
|------|------------|
| TUI | `~/.pi/agent/skills/` 或项目内 `skills/` |
| GUI | `~/.xyz-agent/pi/agent/skills/` 或项目内 `skills/` |

**约束**：Skills 中不得硬编码文件绝对路径。使用相对路径（如 `{topicDir}/changes/reviews/`）或通过 task prompt 注入。

### 5.3 Python 脚本

`gate-check.py`、`collect.py` 等脚本需要 Python 3 + PyYAML。两种模式下通过绝对路径调用。

**约束**：脚本路径在 coding-workflow extension 中通过 `__dirname` 相对定位，不依赖全局安装。

---

## 六、迁移策略

### 6.1 阶段划分

| 阶段 | 内容 | 风险 | 回滚方案 |
|------|------|------|---------|
| **Phase 1** | 建立 monorepo 结构，pnpm workspace 配置 | 低 | 删除配置文件 |
| **Phase 2** | 迁入 extensions（从 pi-extensions），保持 `~/.pi/agent/extensions/` symlink | 中 | symlink 指回原仓库 |
| **Phase 3** | 迁入 coding-workflow + skills（从 harness），保持 symlink | 中 | symlink 指回原仓库 |
| **Phase 4** | 统一 subagent 实现，消除重复代码 | 高 | git revert |
| **Phase 5** | 打通 evolve ↔ retrospect 闭环 | 中 | 功能开关 |
| **Phase 6** | 更新文档、CI、发布流程 | 低 | — |

### 6.2 Symlink 过渡期

迁移期间，通过 symlink 保持向后兼容：

```bash
# TUI 用户（pi 独立模式）
~/.pi/agent/extensions/coding-workflow → xyz-agent-workspace/extensions/coding-workflow
~/.pi/agent/skills/xyz-harness-* → xyz-agent-workspace/skills/xyz-harness-*

# GUI 用户（xyz-agent 模式）
~/.xyz-agent/extensions/coding-workflow → xyz-agent-workspace/extensions/coding-workflow
~/.xyz-agent/pi/agent/skills/xyz-harness-* → xyz-agent-workspace/skills/xyz-harness-*
```

原仓库标记为 archived，README 指向新仓库。

### 6.3 发布策略

| 组件 | 发布方式 | 频率 |
|------|---------|------|
| xyz-agent app | electron-builder 打包 → GitHub Release | 按需 |
| extensions/* | 不发布 npm，用户通过 symlink 或 clone 使用 | 跟随主仓库 |
| skills/* | 不发布，纯 Markdown | 跟随主仓库 |
| packages/plugin-sdk | npm publish | 按需 |
| packages/create-xyz-plugin | npm publish | 按需 |

---

## 七、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 仓库膨胀，clone 慢 | 中 | 低 | Electron 二进制已在 `.electron-dist-cache/`，node_modules 用 .gitignore |
| CI 变长 | 中 | 中 | 分层 CI：extensions 改动不触发 Electron 打包 |
| TUI 用户获取 extensions 困难 | 高 | 中 | 提供 install 脚本自动创建 symlink |
| 两套扩展 API 维护负担 | 低 | 低 | 两者解决不同问题，不会合并，也无需合并 |
| Pi ExtensionAPI 变更影响所有 extensions | 低 | 高 | Pi 是 fork 版本（xyz-pi），API 变更可控 |
| 复盘闭环改动引入 regression | 中 | 中 | 功能开关，evolve 的 harness 维度可独立启用/禁用 |

---

## 八、预期收益

| 维度 | 现状 | 整合后 |
|------|------|--------|
| **维护成本** | 三个仓库各自维护 CI、文档、依赖 | 一套 CI、统一文档、共享依赖 |
| **Subagent 重复** | 三处独立实现 | 一处共享实现 |
| **复盘闭环** | 产出 → 等人看 → 手动吸收 | 产出 → 自动分析 → 自动吸收 |
| **新功能开发** | 跨仓库改动，需要多个 PR | 单仓库改动，一个 PR |
| **TUI/GUI 一致性** | 分散维护，容易出现差异 | 同一份代码，天然一致 |
| **新人理解** | 需要理解三个仓库的关系 | 一个仓库，三层结构清晰 |

---

## 九、决策

**采用方案**：Monorepo 整合，保留三层架构（平台/基础能力/应用）。

**关键约束**：
1. Pi ExtensionAPI extensions 保持独立于 Electron，TUI/GUI 双模运行
2. Skills 保持纯 Markdown，不引入运行时依赖
3. 分层 CI，extensions/skills 改动不触发 Electron 打包
4. Symlink 过渡期至少 2 个月，确保 TUI 用户平滑迁移

**不做**：
1. 不将 Pi ExtensionAPI 扩展改写为 xyz-agent Plugin——两者解决不同问题
2. 不将 coding-workflow 重构为基于 workflow 引擎——抽象层级不同
3. 不合并原仓库——保留作为归档
