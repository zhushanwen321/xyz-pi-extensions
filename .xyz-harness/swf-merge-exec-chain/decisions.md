---
topic: swf-merge-exec-chain
created_at: 2026-07-10
---

# 决策账本 — swf-merge-exec-chain

> 本 topic 的 append-only 决策账本。mid 全程沿用 full 的机制（见 loop-skeleton.md Step 1.2 schema）。

## 跨 topic 总纲引用

本 topic 是「subagent + workflow 合并 → pi-subagents-workflow」三 topic 拆分的 T1（包结构合并 + 执行链统一）。跨 topic 决策（已由 handoff 确认，不可推翻）：

- **合并为一包**（非 package 依赖）——workflow 的 agent() 要委托 SubagentService.execute，产生编译期硬依赖
- **包名** `@zhushanwen/pi-subagents-workflow`，目录 `extensions/subagents-workflow/`
- **旧两包原样保留、不标记 deprecated；deprecated 标记与清理由 T3 负责**（D-004 已确认）
- **ADR-026/029 标 superseded**（由 T3 负责写 ADR-030，本 topic 不写）

## 决策账本（append-only，一行一条决策）

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-000 | 合并为一包 @zhushanwen/pi-subagents-workflow，非 package 依赖 | handoff 已确认：workflow agent() 委托 SubagentService.execute 产生编译期硬依赖 | `D-不可逆` | `ask_user` | `clarity` | `[from: handoff §决策6]` | `confirmed` | |
| D-001 | 本 topic (T1) 只做包结构合并 + 执行链统一，不做删sync/并发池/通知/脚本 | 三 topic 拆分：T1=合并+统一(A+F), T2=删sync+并发池+通知(B+C+D), T3=脚本+文档(E+I+J) | `D-不可逆` | `ask_user` | `clarity` | `[from: 拆分方案]` | `confirmed` | |
| D-002 | 新包版本号 1.0.0 从头起 | handoff 建议；新包名全新版本，changeset 从空开始，用户卸载旧两包装新包 | `D-不可逆` | `ask_user` | `clarity` | `[from: requirements §7]` | `confirmed` | |
| D-003 | AgentRegistry 统一为可配置路径 + mtime 缓存 + 覆盖所有必要路径 | 最长期合理方案：subagents 版 mtime 缓存 + discovery.json 可配置机制更优，补齐 workflow 的路径覆盖（~/.agents/agents, cwd/.agents/agents, extensions, npm packages）。不考虑历史兼容 | `D-不可逆` | `ask_user` | `architecture` | `[from: system-arch §10 D-A3]` | `confirmed` | |
| D-004 | 完全新建 extensions/subagents-workflow/，旧包代码不动 | 旧包原样保留（不需 deprecated 标记），新包从零建（cp 新建，非 git mv）。旧包代码后续版本统一清理 | `D-可逆` | `ask_user` | `architecture` | `[from: requirements §7]` | `confirmed` | |
| D-005 | executeAndAwait 保留 onEvent 透传，保 live-record TUI 进度 | 架构 review MF-1 交叉验证：给 executeAndAwait 加类型化 onEvent 回调（发 AgentEvent），SubprocessAgentRunner 桥接回 workflow liveRecord。live/jsonl-to-agent-event.ts 可删（不再需 raw→AgentEvent 翻译） | `D-不可逆` | `ask_user` | `architecture` | `[from: review MF-1]` | `confirmed` | |
| D-006 | timeoutMs 在 SubprocessAgentRunner 侧合并 signal，不上提 ExecuteOptions | timeoutMs 当前只 workflow 消费；signal 是 runSpawn 已有 abort 通道；YAGNI（subagent tool 用 maxTurns 不需 wall-clock）；不跨包改签名避免与 T2 冲突 | `D-不可逆` | `ask_user` | `architecture` | `[from: review MF-2]` | `confirmed` | |
| D-007 | AgentResult 双类型映射：executeAndAwait 返回 workflow 侧形状（content），内部从 subagents 形状（text）转换 | 需求 review MF-1 发现两包 AgentResult 互斥（workflow content vs subagents text）。executeAndAwait 是 workflow 编排层接口，返回 workflow AgentResult；内部走 subagents 管道拿到 RecordSnapshot 后映射 | `D-不可逆` | `agent-opinionated` | `architecture` | `[from: review MF-1]` | `confirmed` | |
| D-008 | executeAndAwait 不调 resolveModel，SAR 用 ctxModel 填底；model auth 校验由 pi 子进程承担 | 长期方案：workflow 脚本的 model 是开发时决策（非运行时用户输入），pi 子进程校验足够。resolveModel JS 层提前校验是 tool 层优化（针对运行时输入），编排层不需要。与合并前 pi-runner --model 行为等价 | `D-可逆` | `agent-opinionated` | `mid-detail-plan` | `[from: M-5 分析]` | `confirmed` | |
| D-009 | 双重记账一致性标 T2 处理 | T1 不改 record 生命周期；T2「通知合并」会统一 record 管理。T1 只保证正常路径两侧一致 | `D-可逆` | `ask_user` | `mid-detail-plan` | `[from: M-6 确认]` | `confirmed` | |
| D-010 | M-4 子进程 kill 归属迁移到 session-runner.spawnedChildren，dispose 兜底覆盖 workflow 子进程 | M-4 分析确认：session-runner 的 spawnedChildren 全局 Set 覆盖面更广，行为等价且增强；AC-4.6 验证 dispose 无存活子进程 | `D-可逆` | `agent-opinionated` | `mid-detail-plan` | `[from: M-4 分析]` | `confirmed` | |
