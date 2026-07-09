---
verdict: pass
tier: mid
skill: mid-plan
stage: architecture
---

# System Architecture — CW (Coding Workflow Orchestrator)

## 1. 系统设计立场

**核心计算是什么？** CW 的核心是**流程状态机的编排 + gate 验证**，不是业务规则编排，也不是技术流程编排（不 spawn 进程跑 agent）。CW 是一个**有状态的请求处理器**：接收 agent 的 tool call → 校验状态 → 跑 gate → 更新状态文件 → 返回 nextAction。

这个定位决定分层：CW 是**无 IO 副作用的编排层**（除读写 `_cw.db` 和调用 check 脚本/git），不承担 agent 执行、不承担 UI 渲染、不承担 budget 管理（那些归 goal/todo/subagent）。

## 2. 分层架构

采用**简化三层**（非 DDD4），因为 CW 的"领域逻辑"就是状态机转换 + gate 调度，无复杂业务规则：

```
┌─────────────────────────────────────────────┐
│  Tool 接口层（index.ts）                     │
│  registerCodingWorkflowTool + execute        │
│  - typebox schema 校验入参                   │
│  - 按 action 分派到应用层                    │
│  - 组装出参（status/gatePassed/nextAction）  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  应用层（action handlers + 状态机）          │
│  - create/plan/clarify/detail/dev/test/      │
│    retrospect/closeout 各 handler            │
│  - 状态机校验（expectedStatus 强制线性）     │
│  - 编排 gate 调用 + 状态流转                 │
│  - 渐进式提交的累计判定逻辑                  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│  基础设施层（gate 检查器 + 存储 + 解析器）    │
│  - GateRunner: subprocess 调 check_*.py      │
│  - GitValidator: git 命令校验 commit         │
│  - JudgeByExpected: test-orchestrator 内化   │
│  - CwStore: node:sqlite DAO + 事务（原子）│
│  - PlanParser: 解析 plan/clarify/detail JSON │
└─────────────────────────────────────────────┘
```

**为何不用 DDD4**：CW 无领域聚合（topic 是简单状态机封装，不是有复杂不变式的领域对象），无复杂业务规则（状态机本身就是核心约束），无 Port（check 脚本/git 是稳定的命令式调用不需要可替换抽象）。三层够用且不过度设计。

## 3. 模块拆分（按变化轴）

| 模块 | 变化轴 | 为何独立 |
|------|--------|---------|
| `src/index.ts` | tool 注册 API | Pi SDK API 变化时只改这里。同时移除 lib/gates 的 re-export（孤儿代码，CW 不依赖，见 §6）|
| `src/cw/state-machine.ts` | 状态机定义 + nextAction 组装 | 合法转换表与成功去向是一对概念，同处定义。加 full 路径或改流转规则时只改这里 |
| `src/cw/store.ts` | `_cw.db` node:sqlite schema + DAO + 事务 | schema 演进集中此处 |
| `src/cw/gates.ts` | gate 注册表（tier×phase→checker）+ gate 执行器 | 配置与执行同文件（社区惯例），加 check 或调强度时只改这里 |
| `src/cw/plan-parser.ts` | 解析 plan/clarify/detail JSON + expected 结构化字段 | 3 套 JSON schema 变化集中此处（lite 的 expected 是结构化字段，非 markdown key= 正则解析）|
| `src/cw/actions/` | 各 action handler（create.ts/plan.ts/dev.ts/test.ts...）| 每个 action 独立文件，新增 action 不影响其他 |
| `src/cw/types.ts` | judgeByExpected + Expected/Actual/TestCase 类型 | test-orchestrator 内化后的类型落点（D-004，见 §9）|

**拆分原则**：每个模块单一变化轴。`gates` 变化（加 check）不碰 `state-machine`；`store` 的 schema 演进不碰 action handler。

**test-orchestrator 内化后的目录命运**：`src/test-orchestrator/` 目录**整体删除**。其内容分散迁入：judgeByExpected + 类型 → `src/cw/types.ts`；plan-parser 的 expected 逻辑（JSON 结构化版）→ `src/cw/plan-parser.ts`。内化后不再有独立的 test-orchestrator 模块（见 §9 迁移步骤）。

**action 入参与实现约定**（跨模块共用）：
- **topic 定位**：除 create 外，所有 action 入参含 topicId（或 topicDir，CW 内部解析）定位当前 topic。create 返回 topicId，后续 action 用该 topicId。
- **Pi 事件订阅**：CW 是纯 registerTool，不订阅 pi.on 事件。CW 是无状态请求处理器，靠 _cw.db 持久化状态，不依赖事件回调。
- **错误返回**：遵循项目规范，错误用 `throw new Error()`，不返回伪装成功的 content 文本（错误成功模式）。CW 的 throw 被 Pi 捕获后转述给 agent。
- **dependsOn / parallelGroup**：CW 仅记录这两个字段（从 plan/detail JSON 写入 _cw.db），**不消费做依赖编排**——依赖编排归 agent + coding-execute skill 的 Wave DAG 派发，CW 只校验 Wave 维度的 commit 完整性。Wave 可以乱序提交（CW 不强制按 dependsOn 排序）。
- **workspacePath 语义**：_cw.db 的 topic 表 workspace_path 记录 topic 对应的项目目录绝对路径，GitValidator 在该目录下执行 git 命令（支持一个 agent 跨多项目场景，CW 不假设 cwd）。create 时由 agent 传入或默认 cw 进程的 cwd。

## 4. 状态机（核心不变式）

### 4.1 状态定义

```
lite: created → planned → developed → tested → retrospected → closed
mid:  created → clarified → detailed → developed → tested → retrospected → closed
```

### 4.2 状态机表（紧约束，显式转换表）

| 当前状态 | 合法 action | 流转后状态 | 额外前置（跨阶段级联）|
|---------|------------|-----------|-------------------|
| —（无 topic） | **create**（入口 action）| created | 无 |
| created (lite) | plan | planned | 无 |
| created (mid) | clarify | clarified | 无 |
| clarified (mid) | detail | detailed | 无 |
| planned (lite) | dev | developed | 无（首次有效提交即流转）|
| detailed (mid) | dev | developed | 无（首次有效提交即流转）|
| developed | test | tested | **require: dev 阶段全 Wave committed**（防跳过未完 dev）|
| tested | retrospect | retrospected | **require: test 阶段全 testCase passed**（防跳过未完 test）|
| retrospected | closeout | closed | 无 |

**两重校验**：CW 在 action handler 入口做两道校验——
1. **状态机线性**：`currentState ∈ expectedStatuses[action]`，不满足 throw `illegal state transition`，不跑 gate
2. **跨阶段 gatePassed 级联**（渐进式阶段进下一阶段时）：上一阶段的累计完成信号必须为 true（dev 全 Wave committed / test 全 case passed），否则 throw `previous phase incomplete`，不跑 gate

两道都是主强制点（D-009）。第二道解决「developed/tested 态内可跳进下一阶段」的漏洞——仅靠 status 相等无法防 agent 丢掉剩余 Wave/case 直接进下一阶段。

### 4.3 渐进式 action 的状态语义

dev 和 test 是渐进式的，状态流转规则特殊：
- **进入态**：首次有效提交时流转到 developed/tested（如 planned→developed）
- **态内推进**：后续提交不流转状态，更新 `_cw.db` 的 wave.committed / test_case.status
- **态完成信号**：靠 `gatePassed: true` 表达（全 Wave committed / 全 case passed），不靠状态流转

agent 据 `gatePassed` 判断能否进下一步，不是据 status。status 表示"当前所处阶段"。

### 4.4 严格度选择：紧（显式转换表）而非松（只守终态）

选紧约束的理由：CW 的核心价值就是强制线性流转。松约束（只检查终态 closed）会让中间状态可乱跳，失去防跳过能力。显式转换表的代价（加 action 要改表）远小于收益（防跳过）。

## 5. Gate 注册表（核心配置）

### 5.1 gate 强度定义

| gateTier | 含义 | agent 可信度 |
|----------|------|------------|
| weak-structural | 仅检查文件存在 + 结构完整（章节/占位符）| 低，内容正确性靠 review/人判 |
| medium-git | commitHash 经 GitValidator 三项校验（存在/属本仓库/非空）| 中（dev，有真实凭证不重算业务）|
| medium-coverage | commitHash 校验 + 信自然语言声明，不重算业务断言（mid test）| 中（信声明）|
| strong-recompute | 机器重算 actual vs expected，丢 AI 声明 | 高（密封）|

### 5.2 tier × phase → gate 映射

下表是 gates.ts 的核心数据（checker 列为调用的检查器，tier 列为 gate 强度）：

| tier | phase | checker | gate 强度 | review 桩 |
|------|-------|---------|----------|----------|
| lite | plan | check_plan.py | weak-structural | CW 产 review-plan 文件 |
| lite | dev | GitValidator（git 三项校验）| medium-git | 无（渐进式，无单次 gate 文件）|
| lite | test | judgeByExpected（机器重算）| strong-recompute | 无（渐进式）|
| lite | retrospect | check 文件存在+非空 | weak-structural | 无 |
| lite | closeout | check_closeout.py（6 项归档检查）| weak-structural | 无（脚本自述不走 review gate）|
| mid | clarify | check_clarity.py + check_architecture.py | weak-structural | CW 产 review-clarity + review-architecture 文件 |
| mid | detail | check_issues.py + check_nfr.py + check_code_arch.py + check_execution.py | weak-structural | CW 产 4 个 review 文件（review-issues 等）|
| mid | dev | GitValidator | medium-git | 无（渐进式）|
| mid | test | 信声明 + commitHash 记录（GitValidator 校验）| medium-coverage | 无（渐进式）|
| mid | retrospect | check 文件存在+非空 | weak-structural | 无 |
| mid | closeout | check_closeout.py | weak-structural | 无 |

**review 桩机制（解 check_*.py 与 mid 编排不兼容）**：full-* 的 check 脚本硬性要求 changes/ 下对应 review 文件（verdict: APPROVED）。但 mid 的 review-fix-loop 是 skill 阶段（设计期）in-process 跑的（派 reviewer subagent），默认不落盘。

**时序与数据来源**（修正：review 文件由 **skill 阶段产出**，不是 CW 运行时产）：
1. skill 阶段（mid-plan / mid-detail-plan）的 review-fix-loop 跑完，收敛后把 review 报告（含 reviewer 汇总 must_fix + CONVERGED 结论）作为交付物落盘到 changes/ 下对应 review 文件（如 review-clarity.md，verdict: APPROVED）。这是 skill 改造新增的一步（见 §10 skill 收口）。
2. agent 调 CW submit(clarify/detail) 时，该 review 文件已存在于 changes/ 目录。
3. CW gate 跑 check_*.py，脚本自动发现 review 文件并通过校验。CW 不产桩、不理解 review 内容，只负责跑 check 脚本。

**为何这不算造假**：review 确实在 skill 阶段做了（reviewer subagent 跑过），skill 改造只是把原本 in-memory 的结果结构化落盘。check 脚本的 review 要求由 skill 阶段满足，CW 只是调用方。

**现有 skill 需改造**：lite-plan/mid-plan/mid-detail-plan 的 review-fix-loop 末尾增加「review 报告落盘」步骤。归到 §10 skill 收口改造（与 D-007-REVISIT 同批）。

**gateTier 细分说明**：medium 拆为 medium-git（dev，commitHash 经 GitValidator 三项校验）和 medium-coverage（mid test，commitHash 校验 + 信声明，但不重算业务断言）。两者强度不同，诚实区分。lite test 的 strong-recompute 是唯一密封档（机器重算丢 AI 声明）。

**mid test commitHash 语义**：test 阶段本身跑测试不产新 commit，mid test 提交的 commitHash 指向 **dev 阶段产出的、被本次测试覆盖的 commit**（即 testCase 所验证的代码版本）。GitValidator 校验该 commit 真实存在且属于本仓库，确保测试是基于真实代码跑的，而非凭空声明。一个 testCase 可关联一个 commitHash（通常是对应 Wave 的 dev commit）。

### 5.3 gate 执行规则

- **多 checker（如 mid detail 的 4 个）**：串行跑，全 pass 才 pass，任一 fail 则整体 fail（fail-fast，剩余不跑）。
- **gate 结果记录**：每次 action 调用都追加 `gateHistory`（含 tier/result/report/ts），渐进式 action 标 `progressive: true`。
- **gateTier 透传**：返回值的 `gateTier` 字段直接来自注册表，让 agent 知道本次 gate 强度。

## 6. 外部依赖分类与 Port 决策

| 依赖 | 分类 | Port 决策 |
|------|------|----------|
| check_*.py 脚本 | Local-sub（自有可控，subprocess 调用）| **不做 Port**。直接 subprocess 调用。脚本是稳定的内部契约，无需可替换抽象。 |
| git 命令 | True-external（第三方但极稳定）| **不做 Port**。git CLI 是事实标准，签名固定。 |
| `_cw.db` 存储 | In-process（node:sqlite 内置）| **不做 Port**。直接用 Node 内置 node:sqlite（D-016）。原子写/崩溃恢复归 sqlite 事务天生支持。 |
| test-orchestrator 判定 | In-process（同进程函数调用）| **不做 Port**。judgeByExpected 是纯函数，直接 import。 |
| Pi SDK（registerTool 等）| True-external（框架）| **不做 Port**。SDK 升级时直接改 index.ts。 |

**结论：CW 不引入任何 Port 抽象**。所有依赖要么是稳定的命令式契约（脚本/git），要么是同进程调用。这是 Seem 纪律：零 Port = 零假设 seam。

**零 Port 的代价（诚实标注）**：正因为没 checker seam，mid 被迫复用 full-* 的 check 脚本，而两者的 review 产物契约不同（full 独立产 review 文件，mid in-process 不产），需要 CW 补 review 桩（§5.2）。若未来 checker 语义分化加剧（如 full 接入 CW），可能需要 fork 脚本或加 CLI flag。这是 YAGNI 的已知成本。

**child_process 运行时约束**：项目约束（CLAUDE.md）限制扩展用 child_process，仅 pi-workflow（spawn）/pi-subagents（execFileSync 只读 git）有豁免。CW 是第三个 child_process 用户，解决方案：GateRunner 用 spawn 调 python check_*.py（与 pi-workflow spawn 先例同模式）；GitValidator 用 execFileSync 调只读 git 命令（cat-file/merge-base/diff-tree，与 pi-subagents 先例同模式，无写副作用）。

**lib/gates 去留**：codebase 现有 `lib/gates/`（ReviewGate/TestFixLoopGate）是孤儿代码——`src/index.ts` re-export 但全 repo 无生产消费方。CW 引入新 gate 体系后，`src/index.ts` 移除 lib/gates 的 re-export（避免新旧 gate 体系并存混淆）。lib/gates 代码本身保留（不删历史代码），仅断开 re-export。

## 7. 核心不变式守卫

| 不变式 | 守卫位置 | 违反时行为 |
|--------|---------|----------|
| tier 不可变 | plan/clarify/detail handler 校验 JSON.format === topic.tier | throw，gate fail |
| 状态机线性 | 每个 action handler 入口校验 expectedStatus | throw，不跑 gate |
| **跨阶段 gatePassed 级联** | test handler 入口 require dev 全 Wave committed；retrospect handler 入口 require test 全 case passed | throw `previous phase incomplete`，不跑 gate |
| 渐进式提交原子性 | sqlite 事务（BEGIN/COMMIT/ROLLBACK）| 事务失败 ROLLBACK `_cw.db` 不变 |
| lite test 丢 claimedStatus | test handler（lite 分支）调 judgeByExpected 忽略入参 claimedStatus | 机器 verdict 为准 |
| dev commit 真实性 | GitValidator 三项校验（存在/属于仓库/非空）| 该 task 记 fail |
| mid test commitHash 真实性 | GitValidator 校验（同 dev）| 该 case 记 fail |
| gate 历史完整 | 每个 action handler finally 块追加 gateHistory | 不记录则 action 视为未完成 |

## 8. 核心模型：`_cw.db` 关系表 schema（D-016 node:sqlite）

CW 的核心数据模型是 CwTopic（一个 topic 的完整状态）。D-016 改用 node:sqlite + 关系表模式，CwTopic 拆成 4 张表。逻辑模型（CwTopic TS 接口）保留作为应用层类型，存储层是 sqlite 表（DAO 负责两者转换）。

| 模型 | 类型 | 职责 |
|------|------|------|
| CwTopic | 状态封装（逻辑模型，DAO 拼装）| 一个 topic 的完整状态，CW 唯一持久化根（非 DDD aggregate，见 §2）|
| CwStatus | 值对象（枚举）| 状态机节点 |
| Wave | 实体 | dev 任务单元，含 committed commitHash |
| TestCase | 实体 | test 任务单元，含 status/actual/screenshot |
| GateHistoryEntry | 值对象 | gate 执行记录（不可变）|
| Evidence | 值对象 | 收尾证据快照 |
| GateTier | 值对象（枚举）| gate 强度档位 |

### 8.1 sqlite 关系表 schema（D-016，存储层）

CwTopic 拆成 4 张表。SQL 语句（DDL）草拟，详细索引/约束属 code-arch：

```sql
PRAGMA user_version = 1;  -- schema 版本（迁移用，关联 #11）

CREATE TABLE topic (
  topic_id TEXT PRIMARY KEY,        -- cw- 开头加 slug
  slug TEXT NOT NULL,
  tier TEXT NOT NULL,               -- "lite" | "mid"，锁定（D-003）
  objective TEXT NOT NULL,
  workspace_path TEXT NOT NULL,
  created_at TEXT NOT NULL,         -- ISO
  status TEXT NOT NULL,             -- CwStatus
  plan_format TEXT,                 -- "lite"|"mid-clarify"|"mid-detail"，首次锁定
  coverage INTEGER                  -- test 阶段记录
);

CREATE TABLE wave (
  topic_id TEXT NOT NULL,
  id TEXT NOT NULL,                 -- W1
  depends_on TEXT,                  -- JSON array
  parallel_group TEXT,
  committed TEXT,                    -- commitHash 或 NULL
  changes TEXT,                      -- JSON array（lite technicalChanges id）
  issues TEXT,                       -- JSON array（mid issue id）
  PRIMARY KEY (topic_id, id),
  FOREIGN KEY (topic_id) REFERENCES topic(topic_id)
);

CREATE TABLE test_case (
  topic_id TEXT NOT NULL,
  id TEXT NOT NULL,                 -- E1 / T1.1
  layer TEXT NOT NULL,              -- lite: mock|real；mid: unit|integration|e2e|perf-chaos
  scenario TEXT NOT NULL,
  steps TEXT NOT NULL,
  expected TEXT,                    -- JSON（lite 结构化机器重算基准）
  assertion TEXT,                   -- 自然语言（mid 信声明，不重算）
  executor TEXT NOT NULL,
  status TEXT NOT NULL,             -- pending|passed|failed
  actual TEXT,                      -- JSON（lite test 提交时填）
  screenshot_path TEXT,
  commit_hash TEXT,                 -- GitValidator 校验
  judged_at TEXT,
  PRIMARY KEY (topic_id, id),
  FOREIGN KEY (topic_id) REFERENCES topic(topic_id)
);

CREATE TABLE gate_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  action TEXT NOT NULL,
  gate TEXT NOT NULL,
  tier TEXT NOT NULL,               -- GateTier
  result TEXT NOT NULL,             -- pass|fail
  ts TEXT NOT NULL,
  report TEXT,
  progressive INTEGER,             -- 0|1
  FOREIGN KEY (topic_id) REFERENCES topic(topic_id)
);
```

### 8.2 CwTopic 逻辑模型（应用层类型，DAO 拼装）

```typescript
// 应用层操作的对象（DAO 从 4 表拼装）
interface CwTopic {
  schemaVersion: number;   // 当前 1，对应 PRAGMA user_version
  topicId: string;
  slug: string;
  tier: "lite" | "mid";      // 锁定（D-003）
  objective: string;
  workspacePath: string;
  createdAt: string;         // ISO
  status: CwStatus;
  planFormat?: string;       // "lite" | "mid-clarify" | "mid-detail"
  waves: Array<{...}>;       // 从 wave 表拼装
  testCases: Array<{...}>;   // 从 test_case 表拼装
  gateHistory: Array<{...}>; // 从 gate_history 表拼装
  evidence?: {...};          // 收尾时拼装（快照）
  coverage?: number;
}

type CwStatus = "created" | "planned" | "clarified" | "detailed" | "developed" | "tested" | "retrospected" | "closed";
type GateTier = "weak-structural" | "medium-git" | "medium-coverage" | "strong-recompute";
```

**schema 演进策略（D-016）**：用 sqlite PRAGMA user_version 记录 schema 版本（当前 1）。CwStore 初始化检查 user_version，按版本号顺序跑迁移函数（ALTER TABLE / CREATE INDEX）。未来加 full 路径状态只需扩 CwStatus 联合类型 + 状态机表 + 对应迁移函数。

**为何选 node:sqlite（D-016）**：架构原选文件方案出于零新依赖，但代价是原子写/崩溃恢复都要自实现。tavily 搜索证据：better-sqlite3 在 Node 24 有官方确认预编译缺失（issue #1384）。node:sqlite 是 Node 内置（v22.5 引入，v23.4 免 flag，v25.7 RC），native build 归 Node 官方。三项实测全过（ESM import / 文件持久化 / 事务原子性——崩溃事务不污染）。experimental 风险可接受（用法是 SQL 标准不会随 API 变）。

**statusHistory 已删除**：原设计的 statusHistory 与 gateHistory（pass 子集）+ status（当前态）双重记账，信息完全可推导。单一真相源用 gateHistory。evidence.gateHistory 快照冗余保留（收尾自包含需求真实）。

**coverage 字段的 tier 分化语义**：lite 路径 coverage = 机器重算的实际通过率（strong-recompute，可信）；mid 路径 coverage = agent 声明的通过率（medium-coverage 信声明，未经机器独立重算，语义弱于 lite）。两条路径的 coverage 数字可信度不同，消费方（如 evidence 追溯）需意识到这个差异。

## 9. test-orchestrator 内化方案（D-004 落地）

内化后 `src/test-orchestrator/` 目录**整体删除**，内容迁入 CW 模块：

### 9.1 迁入什么（迁入后的新位置）
- `judgeByExpected(expected, actual)` 纯函数 + `Expected/Actual/TestCase` 类型 → `src/cw/types.ts`（CW test handler lite 分支直接 import）
- expected 解析逻辑 → `src/cw/plan-parser.ts`（注意：CW 输入是 JSON，expected 是结构化字段，**非原 markdown 的 key= 正则解析**，plan-parser 重写为 JSON schema 解析）
- 全覆盖校验逻辑（allPassed/allTerminal）→ CW test handler 的累计判定

### 9.2 删除什么
- `registerTestOrchestratorTool`（独立 tool 注册）+ 整个 `src/test-orchestrator/` 目录
- OrchestratorStore / session Map（CW 的状态在 `_cw.db` 的 test_case 表，不需要独立 session）
- `src/index.ts` 移除 `registerTestOrchestratorTool` 调用 + test-orchestrator 的 re-export，改为 `registerCodingWorkflowTool`

### 9.3 迁移步骤
1. 创建 `src/cw/types.ts`，迁入 judgeByExpected + Expected/Actual/TestCase 类型
2. 创建 `src/cw/plan-parser.ts`，按 JSON schema 重写（3 套：lite plan.json / mid clarify.json / mid detail.json）
3. CW test handler 直接用 types.ts 的函数 + 类型
4. 删除 `src/test-orchestrator/` 整个目录
5. `src/index.ts` 移除旧注册 + re-export，加 `registerCodingWorkflowTool`

## 10. Skill 收口改造方案（D-007 落地，[REVISIT of D-007] 降级）

> **[REVISIT of D-007]**：原 D-007 要求各 skill 删路由章节 + 改 description。reviewer（红队）指出 D-007 删路由与 D-011 改名用同一推迟理由但待遇相反，且 CW 硬强制在状态机（D-009），删路由是软约束锦上添花。**降级决定**：MVP 只做入口 skill + description 映射句，**不删路由**。彻底删路由与 D-011 改名同步做。理由：CW 状态机已硬强制防跳过，skill 路由即使保留，agent 照走也会撞状态机；删路由的收益是避免双路由信息源冲突（真实但软），可推迟。

### 10.1 新增入口 skill: `coding-workflow`

```
skills/coding-workflow/SKILL.md:
---
name: coding-workflow
description: "启动编码流程的唯一入口。调 coding-workflow tool 的 create-topic 建立 topic，
  然后按上次 action 返回的 nextAction 执行。不要直接调用其他 coding-* skill——
  它们由 CW 在 gate 通过后返回。触发词：开始编码、新功能、create topic、启动 coding-workflow。"
---
# 内容：指导 agent 调 cw(create-topic)，然后按 nextAction 走。不展开各阶段细节。
# 冷启动续跑：读 .xyz-harness 下对应 topic 的 _cw.db，据 status + gatePassed 判断下一步。
```

### 10.2 各阶段 skill 改造（description 映射 + review 落盘，不删路由）

每个 skill（lite-plan/mid-plan/mid-detail-plan/coding-execute/coding-retrospect/coding-closeout）:
- **不删路由**（MVP 降级，[REVISIT of D-007]）
- **保留**：本阶段的设计步骤核心内容
- **改 description 顶部**：加一句"本 skill 唯一目标：产出 CW 对应 action gate 的交付物并通过。完成后调该 cw action，按返回 nextAction 执行，不要自行决定下一步"
- **改交付章节**：从"提示 plan(complete) / 下一步调某 skill"改为"调 cw 对应 action 提交交付物"
- **新增 review 落盘步骤**（含 review-fix-loop 的 skill）：review-fix-loop 收敛后，把 reviewer 汇总 must_fix + CONVERGED 结论落盘到 changes/ 下对应 review 文件（如 review-issues.md，verdict: APPROVED），满足 check_*.py 的 review 前置要求（见 §5.2 review 桩机制）
- **新增 JSON 产出步骤**（plan/clarify/detail skill）：见 §12 JSON schema，skill 产出结构化 JSON 作为 CW 解析源

### 10.3 技术现实约束

Pi 的 skill 通过 `available_skills` 自动暴露，无"私有 skill"机制。收口靠 description 设计让 agent **不想**跳过（每个 skill 只说"过我的 gate 听 CW"），而非 agent **看不到**。这点已在 D-007 的 rationale 标注。

### 10.4 skill ↔ CW action 映射表（D-011 改名前的现状名）

D-011 推迟改名，现状 skill 名与 CW action 名存在不对齐，agent 需查此表。改名后（D-011 落地）skill 名与 action 名对齐，此表简化。

| tier | CW action | 触发 skill（现状名）| skill 产出 | CW gate |
|------|-----------|-------------------|-----------|---------|
| lite | create | coding-workflow（入口）| —（建 topic）| 无 |
| lite | plan | lite-plan | plan.json + plan.md | check_plan.py |
| lite/mid | dev | coding-execute | commit(s) | GitValidator |
| lite | test | （agent 直接调，无专用 skill）| testCase 结果 | judgeByExpected |
| lite/mid | retrospect | coding-retrospect | retrospect.md | 文件存在检查 |
| lite/mid | closeout | coding-closeout | 归档文档 | check_closeout.py |
| mid | create | coding-workflow（入口）| —（建 topic）| 无 |
| mid | clarify | mid-plan | clarify.json + requirements.md + system-architecture.md | check_clarity.py + check_architecture.py |
| mid | detail | mid-detail-plan | detail.json + 4 份 .md + code-skeleton/ | check_issues + check_nfr + check_code_arch + check_execution |
| mid | test | （agent 直接调，无专用 skill）| testCase 结果 + commitHash | 信声明 + GitValidator |

**nextAction.skill 字段**：CW 每次 action 返回的 nextAction 含 skill 字段，值为上表"触发 skill"列。agent 据此调 /skill:xxx。test 阶段无专用 skill，nextAction.skill 为空，agent 直接执行测试后调 cw test。

## 11. 目标转换（业务目标 → 架构追溯）

本节验证架构决策如何追溯回 requirements 的业务目标，确保架构服务于需求而非自走。

| 架构决策 | 追溯到 requirement |
|---------|------------------|
| CW 作为 tool（三层）| G1（机器强制）|
| 状态机线性 + expectedStatus 校验 | G1（防跳过）|
| gate 强度标注（gateTier）| G1（诚实部分强制）|
| test-orchestrator 内化 | G2（只认 CW 一个接口）|
| 渐进式提交 + 累计判定 | G3（任务粒度追溯）|
| JSON 结构化 + format 锁 tier | G1（tier 锁定）+ G3（任务可解析）|
| skill 收口 + 入口 skill | G2（agent 不知全貌）— MVP 降级版（[REVISIT of D-007]）|
| 不引入 Port | 约束（复用现有脚本，YAGNI；代价：mid 需补 review 桩，见 §6）|

**evidence 追溯的诚实标注**：§11 原把"goal_control(complete) 的 evidence 含 CW topicId"列为架构追溯项，但 D-009 明确 CW 不耦合 goal，evidence 链路是 agent 中介（agent 可不引 topicId 直接调 goal complete）。架构只追溯到 G1 的状态机部分，evidence 部分是 agent-mediated 非机器强制，事后靠 sqlite3 _cw.db 对账兜底。

## 12. JSON schema 草案（D-006 落地，skill 产 CW 解析）

D-006 要求 plan/clarify/detail 阶段的产出必须是结构化 JSON（CW 直接解析拆任务），而非 markdown。现有 skill 产 .md（给人读）+ .html（可视化），需新增 .json（给机器读）作为第三产出物。本节定义 3 套 JSON schema 草案。

### 12.1 设计立场：为何 skill 产 JSON

- **方案 A（选定）**：skill 在 final 步骤额外产 JSON（.md 给人 review + .json 给 CW 解析 + .html 给可视化，三产出）。
- 方案 B（否决）：CW 从 .md 解析——D-006 已否决，markdown 解析不可靠。
- 方案 C（否决）：agent 中介转换——agent 手工把 .md 转 JSON 易出错，且 agent 不应承担格式转换职责。

**skill 改造归属**：JSON 产出是 lite-plan / mid-plan / mid-detail-plan 三个 skill 的 final 步骤新增（与 §10.2 review 落盘同批，归 skill 收口改造）。skill 产 JSON 的数据源是其自身已产出的 .md 内容的结构化抽取。

### 12.2 plan.json（lite-plan 产出）

```typescript
interface LitePlan {
  format: "lite";              // 必须 === topic.tier，否则 CW 拒绝
  objective: string;
  waves: Array<{
    id: string;                // W1
    changes: string[];         // technicalChanges id
    dependsOn: string[];
    parallelGroup?: string;
  }>;
  testCases: Array<{
    id: string;                // E1
    layer: "mock" | "real";
    scenario: string;
    steps: string;
    expected: { url?: string; text?: string };  // 机器重算基准
    executor: string;
  }>;
}
```

### 12.3 clarify.json（mid-plan 产出）

mid clarify 阶段产 requirements + architecture（设计文档），不含任务清单（任务在 detail）。clarify.json 主要是 tier 确认 + 交付物引用，CW 据此跑 check_clarity + check_architecture。

```typescript
interface MidClarify {
  format: "mid-clarify";       // 必须 === "mid-clarify"
  objective: string;
  deliverables: {
    requirements: string;      // 文件路径，如 "requirements.md"
    systemArchitecture: string; // "system-architecture.md"
  };
  // 不含 waves/testCases（mid 任务在 detail 阶段解析）
}
```

### 12.4 detail.json（mid-detail-plan 产出）

mid detail 阶段产 issues + nfr + code-arch + execution-plan，含任务清单。detail.json 含 waves + testCases，CW 解析后写入 _cw.db（wave/test_case 表）。

```typescript
interface MidDetail {
  format: "mid-detail";        // 必须 === "mid-detail"
  objective: string;
  waves: Array<{
    id: string;                // W1
    issues: string[];          // issue id（mid 以 issue 为任务单元）
    dependsOn: string[];
    parallelGroup?: string;
  }>;
  testCases: Array<{
    id: string;                // T1.1（mid 格式）
    layer: "unit" | "integration" | "e2e" | "perf-chaos";
    scenario: string;
    steps: string;
    assertion: string;         // 自然语言断言（信声明，不重算）
    executor: string;
  }>;
  deliverables: {
    issues: string;
    nonFunctional: string;
    codeArchitecture: string;
    executionPlan: string;
  };
}
```

### 12.5 plan-parser 解析规则

- CW submit(plan/clarify/detail) 入参含 JSON 文件路径或内联 JSON
- plan-parser 按三种 schema 解析，校验 format 字段 === topic.tier 锁定值
- pass 时 waves/testCases 写入 _cw.db（wave/test_case 表，clarify 不写任务清单，只确认 tier）
- schema 版本演进：JSON 顶层可加 schemaVersion 字段，plan-parser 向后兼容

**跨系统依赖补并**：JSON schema 草案是 D-006 可行性的关键前提。skill 不产 JSON 则 CW 解析链路断裂。skill 改造（产 JSON）与 review 落盘、description 映射同批，归 skill 收口改造（§10）。

## 13. 遗留物处理与衔接（内化带来的遗留代码）

CW 内化 test-orchestrator + 取代 test-orchestrator tool 注册位后，codebase 有两处遗留物需处理：

### 13.1 `coding-execute.js` workflow 脚本（删）

`extensions/coding-workflow/workflows/coding-execute.js` 是旧的编码执行 workflow 脚本。设计分析确认其存在根本性问题：使用了设计拒绝的工作流路由机制、未接入 test-orchestrator、与 CW 架构有多处冲突。

**处理**：CW 的 dev/test action 取代该 workflow 的职能后，**删除该脚本**。其原承载的「Wave 派发 + worktree 隔离 + test-runner 落盘」逻辑由 CW + coding-execute skill + agent 协作重建（CW 做 gate + 状态机，coding-execute skill 做派发指导，agent 做实际 subagent 派发）。

### 13.2 `check_execute.py`（保留，隶属 coding-execute skill）

`extensions/coding-workflow/skills/coding-execute/scripts/check_execute.py` 是 coding-execute skill 自带的执行后机器门，读 test-results.json 验证。它属 coding-execute skill，不属 test-orchestrator。**跨格式能力**：同时支持 lite 用例 ID（E 加数字，如 E1）和 mid 用例 ID（T 加用例号.序号，如 T1.1），因此 coding-execute skill 在 lite 和 mid 路径都能复用同一个执行后机器门。

**与 CW test gate 的关系**（两者并存，分工不同）：
- `check_execute.py`：coding-execute skill 内部用，**执行后**校验 test-results.json 结构完整性 + 用例覆盖（weak-structural 性质，属 skill 的自我检查）。
- CW test gate（内化的 judgeByExpected / 信声明）：**CW 状态机**用，决定 developed→tested 流转 + gatePassed。

**衔接**：agent 调 coding-execute skill 执行 Wave → skill 跑 check_execute.py 自检 → agent 拿结果调 cw test 传 cases 数组 → CW test gate 判定。两者不冲突：check_execute.py 是 skill 内部门，CW test gate 是状态机门。但需注意 test-results.json 与 cw test 的 cases 数组数据来源一致（同一批 test-runner 跑的结果）。
