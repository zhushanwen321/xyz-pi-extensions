# Clarification — Workflow Extension 整体重构

主 agent 与用户交互过程中确认的信息记录。供追踪 subagent 参考。

## 已确认的核心决策

### 决策来源：4 轮深度讨论

用户通过 4 轮交互确认了以下决策，追踪 subagent 不需要重新质疑这些（除非发现新的矛盾）：

1. **破坏性变更容忍度 = 方案 C**（最大自由度）
   - 保留：workflow 脚本格式、pi.__workflowRun 签名
   - 允许破坏：JSONL 格式、WorkflowStatus 枚举、tool/command 名、内部 API
   - 用户原话："先不用考虑外部兼容性，因为可以 AI 发起调用 workflow，所以问题不大"

2. **tool 收口为 2 个**：`workflow`（运行操作）+ `workflow-script`（脚本操作）
   - 用户原话："tool 收口成 2 个吧"
   - 之前讨论过方案 A（单 tool 9 action）、B（2 tool 按领域）、C（discriminated union 不可行）

3. **command 收口**：仅保留 `/workflows`，移除 `/workflow run|list|abort|save|delete`

4. **ConcurrencyGate**（原 AgentPool）
   - 重命名 + maxConcurrency 4→5（**后修正：D-13 改为保持 4，无数据支撑变更**）
   - 用户质疑过"真的有必要吗"，主 agent 调研后确认：pi 不复用进程（每次 spawn 新的），但并发度限制必要
   - 职责瘦身：soft limit 移到 Budget

5. **Worker 线程模型保留**

6. **状态机简化**：8 态 → 3 态 + doneReason

7. **核心模型**（原 Round 1 提 9 个领域模型；D-11 删 ApprovalPolicy 后为 8 个；D-12 改三层后归 Engine 层而非独立 Domain 层）

## pi.__workflowRun 的真实使用场景（已调研）

被 2 个外部 caller 使用，都是 coding-workflow 的 gate（`gate.ts:32` 仅是类型注释，不实际调用）：

| Caller | 调用的 workflow |
|--------|----------------|
| `extensions/coding-workflow/lib/gates/review-gate.ts` | phase1/phase2/phase3-review-gate |
| `extensions/coding-workflow/lib/gates/test-fix-loop.ts` | phase4-test-fix-loop |

调用模式一致：`await workflowRun(name, args, signal, timeoutMs)` → 消费 `{status, scriptResult, error, runId}`。这个契约必须保持。

## AgentPool 的事实（已验证）

- `pi-runner.ts:runPiProcess` 每次 `spawn` 新 pi 进程，跑完退出，**不复用**
- AgentPool 不维护进程池，是并发信号量 + FIFO 队列
- soft limit 预警（500 调用）当前在 AgentPool 里，语义上属于 Budget

## 现有架构的关键缺陷（已分析）

详见前几轮讨论，核心：
1. RunResources 扁平化（6 字段生命周期不同）
2. 状态机 8 态混入终止原因
3. 5 个重叠 dependency interface
4. WorkflowScript 散落 5 个 infra 文件未建模
5. WorkerHandle 是裸 Worker + 散落竞态防护
6. ApprovalPolicy 是裸 Set + 散落条件
7. engine 层混合用例编排和基础设施

## 待追踪 subagent 注意

- 本需求是**架构重构**，非 CRUD/业务系统
- User Journey 和 Failure Path 视角适用（有用户操作和失败路径）
- Data Lifecycle 视角：部分适用（WorkflowScript/WorkflowRun 有生命周期，但不是 CRUD）
- API Contract 视角：适用（tool/action 是接口契约）
- State Machine 视角：**强适用**（状态机简化是核心需求）
- 不要追问"为什么重构成这样"——决策已在 4 轮讨论中确认，你的任务是找遗漏的 gap

## Tracing Round 1 新增决策（用于收敛复核参考）

Round 1 追踪发现 28 个 gap，处理结果：
- F 类 21 个全部确认成立，将在 domain-models.md 登记为保留契约
- D 类决策如下：
  - D-8: pi.__workflowRun 签名改为 `{status:"done", reason: DoneReason, ...}`，同步改 2 个 gate caller（review-gate.ts / test-fix-loop.ts；gate.ts:32 仅注释不算）（用户选方案 C）
  - D-9: 废弃 restart 操作（G-006，TUI + orchestrator 一起删）
  - D-10: trace 单一来源 = instance.trace，废弃 appendEntry workflow-trace 双写（G-018=A）
  - D-11: ApprovalPolicy 降级为值对象（G-008，不是 service）
  - G-001/C/D-4/G-004 已合并到上述决策解决

## Tracing Round 2 新增决策

Round 2 发现 2 个新 gap（D 类，根因相同：domain 零依赖违反），已处理：
- **G2-001 ApprovalPolicy 持久化解耦**：recordApproval 走 `ApprovalStore` port（Infra 调 pi.appendEntry），session_start 时 Application 调 `store.loadApproved()` 注入 Set。domain 不依赖 pi.appendEntry/SessionEntry。
- **G2-002 WorkerHandle/ConcurrencyGate 拆 interface/impl**：domain 定义 `IWorkerHandle`/`IConcurrencyGate` interface，Infra 提供 `WorkerHandleImpl`（持 node:worker_threads.Worker）/`ConcurrencyGateImpl`（持 spawn）。RunRuntime 持 interface，不依赖具体类。
- 两者根因：domain-models 最初把带技术副作用的模型与纯 domain 混列。已在 domain-models.md 补「层归属与依赖注入策略」节明确规则。

## Tracing Round 3 新增决策

Round 3 发现 1 新 gap（D 类），已处理：
- **G3-001 RunRuntime pause/resume 生命周期矛盾**：domain-models.md 中 RunRuntime.release("pause") 注释说"保留 gate+controller"，但 WorkflowRun 不变式要求 pause 时 runtime=undefined，且 AbortController 一次性无法复用。修正为：pause 时丢弃整个 RunRuntime，resume 时 assignRuntime 重建三个实例（worker/gate/controller）。gate 语义从"per-run 保留"调整为"per-running-segment 重建"。callCache 在 RunState 里跨 runtime 存活，worker 重跑时 replay。

## Tracing Round 4 新增决策

Round 4 发现 1 新 gap（G4-001，实为 G3-001 遗漏）：
- **G4-001 第 10 节 RunRuntime.release 注释未同步**：Round 3 处理 G3-001 时只改了 clarification 和失败处理矩阵节，漏改了第 10 节类定义内的 release 方法注释和 gate 字段注释。已修正：release 注释改为"整个 RunRuntime 被丢弃"，gate 字段注释改为"per-running-segment 实例"，并补充了 mode 参数语义说明（pause/terminal 实际等价，保留枚举为可读性）。

## Tracing Round 5 新增决策

Round 5 发现 1 新 gap（G5-001，与 G3-001 语义不同）：
- **G5-001 retryNode/worker-error-retry 的原地替换语义**：G3-001 处理 pause/resume（status 变化），但 retryNode 和 worker error retry 是 status 不变的原地重建。现有 assignRuntime/releaseRuntime 处理不了（release+assign 会瞬间违反不变式，直接覆盖泄漏旧 worker）。决策：引入 `WorkflowRun.replaceRuntime(newRt)` 方法，原子完成释放旧 runtime + 绑定新 runtime，全程保持不变式。选方案 B（独立 replaceRuntime 方法）而非 A（扩 assignRuntime 双语义）/C（走 paused 中间态）/D（放宽不变式）。

## Tracing Round 6 新增决策

Round 6 发现 1 新 gap（G6-001，G5-001 的边界遗漏）：
- **G6-001 retryNode 在 paused 状态与 replaceRuntime 不变式冲突**：G5-001 的 replaceRuntime 只定义了 running 场景，但现状 retryNode 允许 paused 调用（lifecycle.ts:219 的灰色地带）。决策：retryNode 前置条件改为 status==="running" only（方案 A），paused 下拒绝（要 retry 先 resume）。理由：paused 下 retry 语义模糊（worker 要不要立即跑？），明确为 running-only 消除灰色地带，不变式保持。这是行为变化（原允许 paused retry），但属于把未定义行为明确化。

## 架构重审新增决策（D-12/D-13，主 agent 跳出 spec 修正追踪视角）

Phase 1 spec 收敛后（10 轮追踪），主 agent 从架构前提本身重新审视，识别出一批「为满足 DDD 四层教条而制造的伪抽象」。与用户讨论后确认：workflow 本质是技术编排引擎而非业务系统，不套 DDD 四层。

- **D-12 架构从四层改为三层（Interface/Engine/Infra）**：workflow 无业务领域规则，所有「模型」都是技术概念（预算计数器/执行日志/线程句柄/信号量）。强行建 Domain 层会沦为空壳，且为满足「Domain 零依赖」需造 IWorkerHandle/IConcurrencyGate 双层 interface + ApprovalStore port（只有一个实现的 interface = 伪抽象）。三层承认 Engine 是核心。原四层 spec 的真实改进（状态机简化、RunState/RunRuntime 分离、Context 收敛、tool 收口）全部保留。具体砍掉：(1) Domain 层整层 → 模型归 Engine；(2) Application 层 3 个 Service → Engine free functions；(3) IWorkerHandle/IConcurrencyGate interface → Infra 直接具体类；(4) ApprovalPolicy class + ApprovalStore port → Interface 层 helper 函数；(5) AgentCall.execute() 上帝方法 → Engine executeAgentCall() 函数；(6) Budget.onConsume 回调 → 查询式 isSoftLimitReached()；(7) NotificationService class → Interface 层 notifyDone() helper 函数；Ports 6→3（只留 AgentRunner/RunStore/WorkerHost）。
- **D-13 maxConcurrency 保持 4（不改为 5）**：原 D-3 提「4→5」无任何数据/需求支撑，属无理由数值变更。保持现状经验值。D-3 同步修正为「重命名，并发度不变」。
- **D-11 修正（ApprovalPolicy 直接删除）**：原 D-11「降级为值对象」仍保留了 domain 值对象 + port。进一步简化为 Interface 层 helper 函数（现状本就是 2 行代码，无需建模）。

**决策动机**：空壳 Domain 层一旦写出来，会成为后续所有代码的锚点，越往后改成本越高。现在改比实现后改便宜。这是「方案推荐优先长期合理性」原则的应用——三层是长期合理的，四层是带着技术债的。
