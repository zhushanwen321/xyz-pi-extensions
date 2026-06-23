# Tracing Round 4（收敛复核）

## 追踪范围
- spec/clarification/domain-models 版本：含 Round 1（28 gap）+ Round 2（G2-001/G2-002）+ Round 3（G3-001）处理后的版本
- 追踪的视角：5 视角完整重跑（User Journey / Data Lifecycle / API Contract / State Machine / Failure Path）
- 源码验证：extensions/workflow 的 run-resources.ts / state.ts / terminate-instance.ts / worker-manager.ts / lifecycle.ts / error-handlers.ts / orchestrator-budget.ts / agent-call-handler.ts / agent-pool.ts / state-store.ts / config-loader.ts / index.ts / commands.ts / tool-workflow-run.ts，及 coding-workflow/lib/gates/review-gate.ts

## 收敛判定

**未收敛**：发现 1 个新 gap（G4-001）。该 gap 是 Round 3 处理 G3-001 时的**遗漏**——G3-001 决策已写入 clarification.md 和 domain-models.md 的「失败处理矩阵」节，但 domain-models.md **第 10 节 RunRuntime.release 的方法签名注释**未被同步修正，导致 spec 内部直接矛盾。

## Gap 列表

| ID | Type | Perspective | Source | Question |
|----|------|------------|--------|----------|
| G4-001 | D | State Machine + Data Lifecycle | domain-models.md §10 vs §「失败处理矩阵」G3-001 条目 | `RunRuntime.release(mode: "pause" \| "terminal")` 第 10 节注释仍为旧语义「pause: 销毁 worker + tempFiles，**保留 gate+controller**（为 resume）」，与 G3-001 决策「pause 时丢弃整个 RunRuntime（含 gate+controller），resume 时 assignRuntime 重建三个实例」**直接矛盾**。实现者读第 10 节会与同文件的「失败处理矩阵」冲突，无法判定 pause 时 gate/controller 的去留。 |

### G4-001 详情

**矛盾两侧**：

- **第 10 节 RunRuntime 类定义**（过时）：
  ```ts
  release(mode: "pause" | "terminal"): void;
  // pause: 销毁 worker + tempFiles，保留 gate+controller（为 resume）
  // terminal: 全释放
  ```
  语义：pause 时部分释放（保留 gate+controller 以便 resume 复用）。

- **「失败处理矩阵」节 G3-001 条目**（更新后）：
  > pause→resume 或 worker error retry 时，assignRuntime 重建新的 RunRuntime（新 worker + 新 gate + 新 controller），**旧 RunRuntime 整个丢弃**。

- **clarification.md Tracing Round 3 决策**：
  > 修正为：pause 时丢弃整个 RunRuntime，resume 时 assignRuntime 重建三个实例（worker/gate/controller）。gate 语义从"per-run 保留"调整为"per-running-segment 重建"。

G3-001 的修正理由明确指出「domain-models.md 中 RunRuntime.release("pause") 注释说"保留 gate+controller"... 修正为...」——即 Round 3 主 agent **知道**要修正这条注释，但实际只更新了 clarification.md 和「失败处理矩阵」节，**漏改了第 10 节类定义内的注释**。

**衍生歧义**（实现者会卡住的点）：

1. `release(mode)` 的 `mode` 参数在 G3-001 语义下是否还有意义？pause 与 terminal 都「整个丢弃 RunRuntime」，清理动作（worker.terminate / tempFiles / gate）两边一致。mode 参数可能多余，或需重新定义区分维度（如「是否随后会 assignRuntime」）。spec 未说明。
2. `RunRuntime.release` 方法与 `WorkflowRun.releaseRuntime()`（第 1 节操作）的关系：releaseRuntime 是否调用 release 再置 runtime=undefined，还是直接清理？spec 未说明。
3. AbortController 一次性（无法复用）是 G3-001 提出的根因之一——G3-001 要求 resume 时新建 controller，但第 10 节字段定义 `controller: AbortController` 未标注「不可跨 pause 复用」。

**建议处理**（供主 agent 参考）：
- 修正第 10 节注释为：`release(): void // 清理 worker/gate/controller 资源；pause 和 terminal 均整个丢弃 RunRuntime，resume 时 assignRuntime 重建`
- 评估是否移除 `mode` 参数（若无实质区分维度则移除，符合 spec「消除 terminateInstance 的 4 个 boolean flag」精神）
- 在第 10 节字段注释补「controller 不可跨 pause 复用（一次性），resume 时新建」

## 5 视角追踪记录

### P1: User Journey（适用）

追踪操作：OP-U01 AI 启动 run / OP-U02 pi.__workflowRun 程序化调用 / OP-U03 /workflows 面板 / OP-U04 pause-resume-abort / OP-U05 retry-node-skip-node / OP-U06 脚本 generate-lint-save-delete-list。

强制检查项（成功后下一步 / 中途放弃 / 重复操作 / 权限不足 / 超时）逐项核对：
- run：完成 notification 唤醒 ✓ / signal abort → pauseOnSignal ✓ / reentry-guard ✓ / ApprovalPolicy（tmp/!approved）✓ / budgetTimeMs → time_limited ✓
- pi.__workflowRun：返回结果 ✓ / signal→abort ✓ / runId 唯一无冲突 ✓ / 程序化跳过 approval ✓ / timeoutMs→deadline→abort ✓
- /workflows：Esc 关闭 ✓ / 每次新建 view ✓
- pause/resume/abort：state machine 守卫非法转换 ✓
- retry/skip：允许 running/paused ✓
- 脚本操作：delete 时 isRunning 检查 ✓

无新 gap。

### P2: Data Lifecycle（部分适用）

实体：WorkflowRun / WorkflowScript / AgentCall / Budget / Trace。

- WorkflowRun：runId 唯一性（timestamp+random）✓ / JSONL rewrite 单行快照 ✓ / session 内无 GC（现有行为，重构不改）✓ / 跨版本不兼容（D-5）✓
- WorkflowScript：tmp>project>user 优先级 ✓ / 60s TTL ✓ / delete 级联检查 isRunning ✓ / 运行中删脚本不影响 run（run 持 scriptSource 副本）✓
- AgentCall/Budget/Trace：封装在 RunState 内，生命周期随 run ✓

无新 gap。

### P3: API Contract（适用）

- workflow tool（7 actions）：input schema ✓ / 错误抛 Error ✓ / reentry-guard isError ✓ / state machine 非法转换抛错 ✓
- workflow-script tool（5 actions）：lint 返回 findings / save/delete 抛错 ✓
- pi.__workflowRun（AC-4 新签名）：{status:"done", reason, scriptResult?, error?, runId} ✓ / gate caller 改 `reason !== "completed"` ✓
  - timeoutMs 触发 → abortRun → reason="aborted"（合理，gate 的 `reason !== "completed"` 覆盖）✓
  - signal abort → reason="aborted" ✓
  - budget/time 超限 → reason="budget_limited"/"time_limited" ✓
  - 「Instance not found」防御分支：D-9 废弃 restart 后该路径不可达（单 session 内无 deleteRun），可作 dead code 移除或防御性抛 Error；不影响接口契约 ✓
- /workflows command：optional runId / SelectList / prefix match ✓

无新 gap。

### P4: State Machine（强适用）

3 态 + DoneReason。转换矩阵核对：
- (init)→running ✓ / running↔paused ✓ / running→done(reason) ✓ / paused→done(reason) ✓ / done→任何 非法 ✓
- paused→done 的 reason 实际只能 aborted（其他 reason 的触发条件在 paused 下不成立：agent call 不跑→budget 不增、time budget check 跳过 paused、worker 已终止→无 error）✓
- 僵尸状态：running+worker 死 → ErrorRecoveryService 3 次重试 → failed ✓ / session 切分支 running→强制 paused ✓
- 非法转换：transitionStatus/WorkflowRun.transition 抛错 ✓

**发现 G4-001**（见上）：RunRuntime.release(mode) 注释与 G3-001 矛盾。

### P5: Failure Path（适用）

失败矩阵核对（对照 domain-models.md「失败处理矩阵」）：
- Worker error/exit 非零 → 3 次重试 + 指数退避，重建整个 RunRuntime（G3-001）✓
- Script error → 3 次重试 → failed ✓
- Agent call 失败 → 3 次重试，预算超限不重试 ✓
- Stale context → 0 次重试 ✓
- Budget/Time exceeded → 0 次，转终态 ✓
- Worker exit 竞态（old vs current worker）→ IWorkerHandle.isCurrent ✓
- session_tree 切分支 → running 强制 paused ✓
- session_shutdown → pause-all ✓
- kill -9 → reconstruct 时 running 转 failed（隐式契约清单）✓
- persist 失败：现有代码也无特殊处理（fs.writeFile 罕见失败），重构不改行为，非本需求范围 ✓
- pi.__workflowRun 与 tool 并发操作同一 run：罕见（gate 运行期 AI 不操作同 runId），现有未处理，重构不改 ✓

无新 gap（除 G4-001 已在 P4 记录）。

## 降级视角记录

无降级。5 视角全部适用（架构重构 + 有用户操作 + 有状态机 + 有失败路径 + 有接口契约 + 有数据生命周期）。

## 摘要

- 新 gap 数量：**1**（G4-001，D 类，spec 内部矛盾——Round 3 处理 G3-001 时漏改第 10 节注释）
- 已追踪视角：User Journey / Data Lifecycle / API Contract / State Machine / Failure Path（全 5 视角，无降级）
- 收敛状态：**未收敛**，需主 agent 修正 domain-models.md 第 10 节 RunRuntime.release 注释（及衍生的 mode 参数语义、controller 一次性说明）
