# 阶段工作摘要 — mid-detail-plan（issues 阶段）

> context-builder 产出。主 agent 进入 issues 锚定前的上下文。
> 注：上游全部已加载到主 agent context（非 compact 后重建），本摘要作交叉确认 + 进入设计树的起点。

## 1. 不可推翻的决策清单（confirmed + D-不可逆）

| id | 决策 | confirmed_by |
|----|------|-------------|
| D-000 | 合并为一包 @zhushanwen/pi-subagents-workflow，非 package 依赖 | ask_user (handoff) |
| D-001 | T1 只做包结构合并 + 执行链统一，不做删sync/并发池/通知/脚本 | ask_user (拆分方案) |
| D-002 | 新包版本号 1.0.0 从头起 | ask_user |
| D-003 | AgentRegistry 统一为可配置路径 + mtime 缓存 + 全路径覆盖 | ask_user |
| D-005 | executeAndAwait 保留 onEvent 透传，保 live-record TUI 进度 | ask_user (review MF-1) |
| D-006 | timeoutMs 在 SubprocessAgentRunner 侧合并 signal，不上提 ExecuteOptions | ask_user (review MF-2) |
| D-007 | AgentResult 双类型映射：executeAndAwait 返回 workflow 形状(content)，内部从 subagents 形状(text)转换 | agent-opinionated |

> D-004（旧包不动）是 D-可逆，不在「不可推翻」清单但已 confirmed。

## 2. 本阶段设计树入口（issues 该遍历的节点）

从 system-architecture §5/§7/§8/§10 推导 issue 的 4 轴：

**状态轴（§5）**：本 topic 不改状态机（WorkflowRun + ExecutionRecord 流转不变）。无 issue。

**模块轴（§7）**：新增/变更模块（每个可能对应 issue）：
- `execution/subagent-service.ts` +executeAndAwait（核心 issue）
- `execution/subprocess-agent-runner.ts` 委托重写（核心 issue）
- `execution/session-runner.ts` 扩展 schemaEnv 参数（D-A6 bridge）
- `orchestration/live/*` 三件套删除 + projectLiveProgress 差异处理
- `orchestration/concurrency-gate.ts` withSlot 适配层
- `orchestration/pi-runner.ts` 删除（spawn-args 构建抽取确认）
- `orchestration/jsonl-parser.ts` 保留判断
- index.ts 合并两包注册 + package.json + extension-dependencies.json

**边界轴（§8）**：
- coding-workflow pi.__workflowRun 契约保持（BC-3）
- pending-notifications EventBus 集成（BC-5）
- structured-output schema 契约（BC-8，D-A6 bridge）

**挑战轴（§10 D-A1~D-A10）**：每个决策对应 issue 的方案约束。

**待确认决策点（M-4/M-5/M-6）**：
- M-4 子进程 kill 归属迁移
- M-5 模型解析归属（executeAndAwait 是否经 ModelConfigService）
- M-6 WorkflowRun + ExecutionRecord 双重记账一致性

## 3. 与上游的接口契约（必须遵守）

**grep 验收规则（§11）**：
- AC-ARCH-1: spawn pi 命中 session-runner + 过渡期 pi-runner（executeAndAwait 上线后委托取代）
- AC-ARCH-2: `function extractYamlField` 只 1 个命中
- AC-ARCH-3: 「复制自 subagents」注释 0 命中
- AC-ARCH-4: `__workflowRun` 在 index.ts 命中
- AC-ARCH-5: ConcurrencyGate.withSlot 语义不变

**Port 清单（§6）**：
- AgentRunner port 保留（实现变更，port 不变）：`run(opts: AgentCallOpts, signal, onEvent?): Promise<AgentResult>`
- RunStore / WorkerHost 不变

**行为契约（§12 BC-1~BC-12）**：12 条全量回归清单（AgentResult 形状 / __workflowRun 签名 / pending emit / subagent tool / error-recovery / schema / timeoutMs / live-progress / no-followUp / nesting-guard）。

**D-A7 重复代码删除分类表**（直接删 / 适配保留 / 有条件删三档）——issue 拆分的方案约束。

## 4. 相关长期约束

- **AGENTS.md 红线**：`pi.extensions` 必须为 `["./index.ts"]`；`pi.skills` 声明 skills 目录
- **AGENTS.md 运行环境**：扩展在 Pi 进程内执行（非独立进程）；同一进程多 session → 模块级 let 变量需闭包/session_start 重建
- **extension-dependencies.json**：新增/删除 extension 必须同步更新（runtime/package/optional 三类依赖）
- **M-1 doc/code 漂移**：CONTEXT.md/AGENTS.md 写「subagents 进程内」但实际 spawn——T3 文档订正项，本 topic 不改文档但 issue 需知晓此约束存在
- **CLAUDE.md 质量检查**：tsc --noEmit 零容忍；单文件 ≤1000 行；单函数 ≤80 行
