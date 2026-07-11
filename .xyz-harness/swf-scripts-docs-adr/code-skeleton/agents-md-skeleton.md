# AGENTS.md 变更骨架（UC-7 / #6）

> 内容骨架（可校验）：标注 AGENTS.md 三处改动点 + 必含内容。
> 实现时合并到根 `AGENTS.md`（及其 symlink 源 `CLAUDE.md`）。
> 关联：code-architecture.md §3.B AGENTS.md 契约 + §6 T7.x 测试。

---

## 实现文件路径

- `AGENTS.md`（根，实际编辑入口）
- `CLAUDE.md`（全局，AGENTS.md 的 symlink 源或反向——按项目实际，两处保持同步）

> ⚠️ check-structure hook 校验 AGENTS.md 目录结构与实际 extensions/ 一致（AC-7.3）。

---

## 改动 1：extensions/ 目录树新增 subagents-workflow（AC-7.1）

> 位置：AGENTS.md 「Monorepo 架构」节的目录树代码块。

**找到**（现有目录树中的 extensions/ 列表）：
```
├── subagents/           → @zhushanwen/pi-subagents
└── pending-notifications/ → @zhushanwen/pi-pending-notifications
```

**改为**（新增 subagents-workflow 条目 + 旧两包标 deprecated）：
```
├── subagents-workflow/    → @zhushanwen/pi-subagents-workflow (T1 合并包：subagents 进程内执行 + workflow DAG 引擎 + workflow()嵌套 + 分层配额；含 execute-full-workflow.js + examples/ 预制脚本)
├── subagents/           → @zhushanwen/pi-subagents (deprecated → pi-subagents-workflow)
├── workflow/            → @zhushanwen/pi-workflow (deprecated → pi-subagents-workflow)
└── pending-notifications/ → @zhushanwen/pi-pending-notifications
```

## 改动 2：包清单表新增/标注（AC-7.2）

> 位置：AGENTS.md 「当前包清单」节的 `extensions/` 表格。

**新增行**（插在 subagents 行之前或之后，保持逻辑分组）：
```markdown
| `extensions/subagents-workflow/` | `@zhushanwen/pi-subagents-workflow` | 进程内 subagent 执行 + workflow DAG 引擎 + workflow() 嵌套编排 + 分层配额（T1 合并包，supersede pi-subagents + pi-workflow） | — |
```

**修改旧两包行**（加 deprecated 标注）：
```markdown
| `extensions/subagents/` | `@zhushanwen/pi-subagents` | ⚠️ **deprecated** → 迁移到 `@zhushanwen/pi-subagents-workflow`（T1 合并）。旧包原样保留，停止维护 | — |
| `extensions/workflow/` | `@zhushanwen/pi-workflow` | ⚠️ **deprecated** → 迁移到 `@zhushanwen/pi-subagents-workflow`（T1 合并）。旧包原样保留，停止维护 | — |
```

## 改动 3：关键约束段更新（「两个 spawn 例外」→ 单包单执行链）

> 位置：AGENTS.md 「关键约束」→「运行环境」节。
> T1/T2 合并后，原「两个 spawn 例外」（pi-workflow + pi-subagents 各 spawn）已变为单包单执行链。

**找到**（现有约束描述）：
```markdown
- 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。两个已知例外：`@zhushanwen/pi-workflow` 通过 `child_process.spawn` 起独立 Pi 进程执行 agent（见 `extensions/workflow/src/infra/pi-runner.ts`，[ADR-025](./docs/adr/025-agent-execution-in-process.md) 记录了向进程内迁移的决策但尚未实施）；`@zhushanwen/pi-subagents` 已改为进程内 `createAgentSession()`，不 spawn，仅在 `execFileSync("git", ...)` 等只读子进程调用上使用 child_process
```

**改为**（单包单执行链描述）：
```markdown
- 扩展不能依赖 fs 之外的 Node.js 原生模块（网络、child_process 等由 Pi 核心控制）。已知例外：`@zhushanwen/pi-subagents-workflow`（T1 合并 pi-subagents + pi-workflow 后的单包）——subagent 执行已统一为进程内 `createAgentSession()` + `executeAndAwait`（不 spawn，单执行链），仅在 `execFileSync("git", ...)` 等只读子进程调用上使用 child_process。原两包（pi-subagents/pi-workflow）已 deprecated，详见 [ADR-030](./docs/adr/030-subagents-workflow-merge.md)
```

## 改动 4（可选）：技术栈/架构节提及合并包

> 若 AGENTS.md 其他段（如「架构」节的职责划分示例）引用了 pi-subagents 或 pi-workflow，按需补充 subagents-workflow。
> check-structure 主要校验目录树 + 包清单（改动 1/2），改动 4 是文档完整性补充。

---

## §6 测试校验点（实现后自查）

- [ ] T7.1：`grep -n "subagents-workflow" AGENTS.md` 目录树命中（AC-7.1）
- [ ] T7.2：包清单表含 `@zhushanwen/pi-subagents-workflow` 行（AC-7.2）
- [ ] T7.3：`bash .githooks/check-structure` exit 0（AC-7.3）
- [ ] T7.4：`grep "两个 spawn" AGENTS.md` 无命中（旧描述已替换，边界校验）

## 风险提示

- **AGENTS.md / CLAUDE.md 同步**：若项目 CLAUDE.md 是 AGENTS.md 的 symlink，改一处即可；
  若是两份独立文件，须同步两处（check-structure hook 会校验）。
- **check-structure 可能触发其他既有问题**：若 hook 报非本次改动的问题，按项目规范处理
  （「类型检查零容忍」原则：全量修复，不接受「不是本次引入」跳过——但 T3 是文档改动，
  若 check-structure 报代码结构问题，区分是否本次目录改动引入，非引入的单独 issue 跟进）。
