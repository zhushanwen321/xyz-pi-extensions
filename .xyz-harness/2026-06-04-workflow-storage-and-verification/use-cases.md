---
verdict: pass
---

# Workflow Use Cases — UC-{N}

> 5 个 UC 提取并细化自 spec.md "业务用例" 章节。每个 UC 包含 Actor / Preconditions / Main Flow / Alternative & Exception Paths / Postconditions / Module Boundaries / 追溯到 spec AC。

---

## UC-1: 长 session 中反复跑 workflow 不被主 JSONL 膨胀困扰

**Actor:** 开发者用户在 IDE 内用 Pi session 跑 pi-workflow

**Preconditions:**
- Pi session 已启动,且至少跑过 1 个 workflow
- 主 session JSONL 文件存在于 `.pi/agent/sessions/{sessionId}.jsonl`
- workflow 在执行期间会触发 `persistState()` 多次

**Main Flow:**
1. 用户在 session 中跑 workflow `w1`,触发 3 次 `persistState`(创建 + 2 次状态变化)
2. `persistState()` 对每个 instance 做两件事:
   a. 写外部文件:`{sessionDir}/workflow-state/{runId}.jsonl`(append-only,每行一个 `SerializedWorkflowInstance` JSON)
   b. 调 `pi.appendEntry("workflow-state-link", { runId, path, updatedAt })` 写轻量 pointer entry(约 200B)
3. 用户跑 10 个不同 workflow(平均 30 agent / workflow,每个 3 次 persistState)
4. 完成后,主 session JSONL 增长约 30 条 link entries(3 × 10),每条 < 200B
5. **结果**: 主 JSONL 总增长 < 6KB,远低于旧实现 5-10KB × 30 = 150-300KB

**Alternative Paths:**
- **AP-1.1**: 用户关闭 Pi,重启 session → `reconstructState()` 从历史 `workflow-state-link` entries 重建 instances,正确恢复 callCache、trace、scriptResult
- **AP-1.2**: 用户跑 force 模式 → 行为同 auto,只是 confirm 跳过(不阻塞此 UC)

**Exception Paths:**
- **EP-1.1**: 外部 state 文件被用户误删 → `reconstructState` 不抛错,跳过该 runId,`ctx.ui.notify` 输出 "WARN: missing state for {runId}"
- **EP-1.2**: 外部 state 文件 JSONL 行损坏(malformed JSON) → `reconstructState` 跳过该行 + notify,其他 instances 正常加载

**Postconditions:**
- 主 session JSONL **不**包含 `customType === "workflow-state"` 的 entry(向后兼容读取时忽略)
- 主 session JSONL **不**包含 `customType === "workflow-state"` 的 entry,只有 `workflow-state-link` 类型的轻量 pointer
- 外部文件按 runId 1:1 存在,可被 GC 工具或用户主动清理

**Module Boundaries:**
- `orchestrator.ts:persistState()`: 写入路径控制者
- `index.ts:reconstructState()`: 重建路径控制者
- `state.ts:serializeInstance()`: 实例→JSON 转换
- 外部文件位置:`{sessionDir}/workflow-state/{runId}.jsonl`

**Coverage:**
| Spec AC | Coverage |
|---------|----------|
| AC-1.1 | Main Flow step 2b + Postconditions |
| AC-1.2 | Alternative Path AP-1.1 |
| AC-1.3 | Exception Path EP-1.1, EP-1.2 |

---

## UC-2: 第一次跑 workflow 时被真实 UI 弹窗确认,不会因 AI 误触发而耗 budget

**Actor:** 开发者用户

**Preconditions:**
- workflow `pr-worktree-flow` 已注册到 workflow config(非 tmp)
- 用户说"帮我提个 PR",AI 错误地将其解释为跑 `pr-worktree-flow`
- `ctx.hasUI === true`(TUI 模式)

**Main Flow:**
1. AI 调 `workflow-run` tool,params: `{ name: "pr-worktree-flow", mode: "auto" }`
2. tool 找到精确匹配,进入 `auto` 分支(`index.ts:556-569`)
3. 检查 `sessionApprovals.has("pr-worktree-flow")` → false(首次)
4. 调 `ctx.ui.confirm("Run workflow?", "Workflow: pr-worktree-flow\nDescription: ...\nSource: [project]\nPath: ...")`
5. UI 弹窗显示在 TUI 上,用户看到 workflow 名和描述
6. 用户按 n 取消
7. tool 返回 `{ content: [{ type: "text", text: "User declined to run 'pr-worktree-flow'." }], details: { action: "run", runId: "", status: "declined", name: "pr-worktree-flow" } }`
8. workflow **不**启动,orchestrator.run() 不被调
9. 主 session budget 0 消耗

**Alternative Paths:**
- **AP-2.1**: 用户按 y 确认 → 调 `orchestrator.run()`,`sessionApprovals.add("pr-worktree-flow")`,写 `workflow-approval-memory` entry,workflow 跑
- **AP-2.2**: 同 session 内用户第二次跑 `pr-worktree-flow` → `sessionApprovals.has("pr-worktree-flow")` 为 true,**不**弹 confirm,直接跑
- **AP-2.3**: 用户跑 `mode="force"` → confirm **不**被调,workflow 直接跑,`details.confirmSkipped: true`

**Exception Paths:**
- **EP-2.1**: `ctx.hasUI === false`(RPC 模式)→ 降级为旧行为 `pi.sendUserMessage("Confirm to run pr-worktree-flow?")` 让 AI 自治决定
- **EP-2.2**: tmp workflow(`source === "tmp"`,由 `workflow-generate` 产生)→ **永远**弹 confirm,不进 sessionApprovals(下次仍弹)
- **EP-2.3**: session_start 后,`sessionApprovals` 从历史 `workflow-approval-memory` entries 重建,确认过的 workflow 不再弹 confirm

**Postconditions:**
- 拒绝的情况下,workflow 状态机无任何变化(无 instance 创建)
- 确认的情况下,workflow 启动,状态机从 `created` → `running`
- 确认的情况下(非 tmp),`sessionApprovals` 永久记住,跨 session_start 重建

**Module Boundaries:**
- `index.ts:workflow-run tool`(`index.ts:484-642` 范围内): confirm UI 调用者
- `index.ts:session_start handler`(`index.ts:155-180`): 重建 sessionApprovals
- `pi.appendEntry("workflow-approval-memory", ...)`: 跨 session 持久化
- `ctx.ui.confirm()`: TUI 弹窗 API

**Coverage:**
| Spec AC | Coverage |
|---------|----------|
| AC-2.1 | Main Flow steps 3-9 |
| AC-2.2 | Alternative Path AP-2.2 |
| AC-2.3 | Exception Path EP-2.3 |
| AC-2.4 | Exception Path EP-2.1 |
| AC-2.5 | Alternative Path AP-2.3 |
| AC-2.6 | Exception Path EP-2.2 |

---

## UC-3: AI 写 workflow 脚本时,complex 执行节点后自动跟 verify 节点,数据可靠性提高

**Actor:** AI(在 workflow-generate 流程中)

**Preconditions:**
- AI 收到任务"批量审查 10 个文件"
- AI 调 `workflow-generate` tool 生成 workflow 脚本
- AI 在 prompt context 中读到 `workflow-script-format` SKILL.md(包含新增的 "Verification Patterns" 章节)
- AI 在 system prompt context 中读到 `tool-generate.ts` 的 `promptGuidelines`(包含新增的 verification rule)

**Main Flow:**
1. AI 开始写 workflow 脚本
2. AI 看到 SKILL.md "Verification Patterns" 章节,包含:
   - **Pattern A**: Node-Internal Verification(简单分类用)
   - **Pattern B**: Follow-up Verify Node(关键执行用)
3. AI 决策:对"审查 10 个文件"这种关键执行,用 **Pattern B**
4. AI 写:
   ```javascript
   const reviewResults = [];
   for (const file of files) {
     const review = await agent({
       prompt: `审查 ${file},输出 { severity: 'high'|'medium'|'low', reason: string }`,
       schema: { ... },
       description: `review-${file}`,
     });
     reviewResults.push(review.parsedOutput);

     // Pattern B: follow-up verify
     const verify = await agent({
       prompt: `验证上一条审查输出 ${review.content} 是否包含严重度评级和理由。输出 { valid: bool, reason: string }`,
       schema: { ... },
       description: `verify-review-${file}`,
     });
     if (!verify.parsedOutput.valid) throw new Error(`verify failed for ${file}: ${verify.parsedOutput.reason}`);
   }
   ```
5. workflow 跑起来,10 个文件被审查,每个后跟 verify 节点
6. AI 漏评 1 个文件(severity 字段缺失)→ verify 节点检测到 `valid: false` → 抛错 → workflow 主动 fail
7. 用户看到 workflow failed,知道是审查质量问题,主动 fix

**Alternative Paths:**
- **AP-3.1**: 简单分类(如同行代码规范检查)→ AI 用 **Pattern A**,单次 `agent()` 即可,prompt 内嵌 self-check
- **AP-3.2**: 极简单操作(如读取文件)→ AI 决定**不**加 verify(`verifyStrategy: "none"`,可选标注)
- **AP-3.3**: AI 完全忽略 verification 规则 → 现状就是依赖 AI 自觉,FR-3 不强制(无 orchestrator hook)

**Exception Paths:**
- **EP-3.1**: verify 节点本身出错(`agent()` 抛错)→ 整个 workflow fail,不会沉默通过
- **EP-3.2**: AI 写 Pattern A 但不写 self-check 提示 → 仍是 AI 责任,SKILL.md 提供示例但无 runtime 强制

**Postconditions:**
- workflow 脚本体现"可验证"原则:关键节点有 verify 兜底
- workflow 失败时,错误信息包含"verify failed: <reason>",用户能定位是数据问题
- `ExecutionTraceNode.verifyStrategy` 字段(可选)记录 AI 决策,用于 debug 统计

**Module Boundaries:**
- `skills/workflow-script-format/SKILL.md`: AI 读 pattern 参考的源头
- `tool-generate.ts:promptGuidelines`: AI system prompt 内的规则
- `worker-script.ts:agent()`: AI 实际跑的 API
- `state.ts:ExecutionTraceNode.verifyStrategy?`: 内存 trace 中记录(不序列化)

**Coverage:**
| Spec AC | Coverage |
|---------|----------|
| AC-3.1 | Main Flow step 2 |
| AC-3.2 | Main Flow step 4 中的设计意图 |
| AC-3.3 | (无 orchestrator/worker-script 改动) |
| AC-3.4 | Alternative Path AP-3.2(可选标注)+ Postconditions |

---

## UC-4: 失控的 workflow 跑到 500 agent 时,用户被及时通知但不被打断

**Actor:** 开发者用户

**Preconditions:**
- workflow `w1` 实际场景需要 800 个 agent call(超出用户预期 200)
- AgentPool 初始化,`onSoftLimitReached` 回调注入到 orchestrator

**Main Flow:**
1. workflow 启动,AgentPool 实例 `pool1` 创建,`totalCallCount = 0`
2. workflow 跑 500 个 agent,`totalCallCount` 从 1 累加到 500
3. 第 501 个 agent spawn 时(从 cache miss → real spawn),`maybeEmitSoftWarning()` 被调
4. `totalCallCount > SOFT_MAX_AGENTS_WARNING (500) && !softWarningSent` → true
5. `softWarningSent = true`,触发回调
6. orchestrator 收到 `onSoftLimitReached({ runName: "w1", totalCalls: 501, budget })`
7. orchestrator 调 `this.pi.sendUserMessage("[workflow:w1] Reached 500 agent calls. Budget: 80000/200000 tokens. Consider aborting if this is unintended.")`
8. 主对话流出现这条 warning(注入到用户能看到的消息)
9. workflow **不**停止,继续跑剩余 300 个 agent
10. 第 600 个 agent,`maybeEmitSoftWarning()` 仍被调,但 `softWarningSent === true`,不重复触发
11. 第 800 个 agent 完成,workflow 正常完成
12. 用户看到 warning,知道"reached 500",决定 ctrl+shift+x abort(下个 workflow 决定)

**Alternative Paths:**
- **AP-4.1**: cache hit 频繁(如同一 callId 调多次)→ cache hit **不**计数,只有 real spawn 计数。`totalCallCount` 反映真实子进程数
- **AP-4.2**: 用户跑第二个 workflow `w2` → 新 AgentPool 实例 `pool2` 创建,`totalCallCount` 从 0 重新开始,`softWarningSent = false`
- **AP-4.3**: 第二个 workflow 跑到 501 → 同样触发 warning(`pool2.softWarningSent = true`),`pool1.softWarningSent` 不受影响(per-instance)

**Exception Paths:**
- **EP-4.1**: 回调 `onSoftLimitReached` 内部 throw → 需 try/catch 包裹(实现时加),避免影响 dispatch 循环
- **EP-4.2**: `pi.sendUserMessage` 抛错 → 同样 try/catch 包裹(orchestrator 层 log)
- **EP-4.3**: 同一 workflow 中用户调 `mode="force"` 重跑(应该不可能,workflow 终态)→ 跳过此 UC

**Postconditions:**
- 主对话流包含 1 条 warning 消息
- workflow 正常完成 / fail / abort(视实际执行)
- `pool1` 被销毁(`pool1.softWarningSent` 状态丢失,下次 workflow 全新开始)

**Module Boundaries:**
- `agent-pool.ts:AgentPool` + `AgentPoolOptions` + `SOFT_MAX_AGENTS_WARNING`: 计数 + 阈值 + 回调
- `orchestrator.ts:new AgentPool({ onSoftLimitReached: ... })`: 回调注入点
- `pi.sendUserMessage(...)`: 注入到主对话流
- 无 hook / 拦截点 → 不影响其他扩展

**Coverage:**
| Spec AC | Coverage |
|---------|----------|
| AC-4.1 | Main Flow steps 3-7 + 10 |
| AC-4.2 | Main Flow step 7 |
| AC-4.3 | Main Flow step 9 |
| AC-4.4 | Alternative Path AP-4.1 |
| AC-4.5 | Alternative Path AP-4.3 |
| AC-4.6 | 注入模式(Main Flow step 6 + `onSoftLimitReached` callback 签名) |

---

## UC-5: 6 个月后回看代码的人能顺着调研链找到完整决策

**Actor:** 6 个月后回看代码的开发者(可能是本人也可能是新成员)

**Preconditions:**
- 项目在 git 仓库,workflow 目录有 `docs/workflow-research/` 子目录
- Phase 1 spec.md + Phase 2 plan.md + Phase 3-5 deliverables 都已 git commit

**Main Flow:**
1. 开发者读 `extensions/workflow/src/orchestrator.ts`,发现 `persistState` 不再写 `workflow-state` entry,改写 `workflow-state-link`
2. 开发者疑问:"为什么改成 external storage?为什么不直接 GC 旧 entries?"
3. 开发者打开 `docs/workflow-research/`,从 README.md 看到时间线
4. 顺着时间线,开发者读到 `05-结论与建议.md`(P0/P1/P2 issues)→ `06-Claude-Code-Workflow-TUI.md`(TUI 改进方向)
5. 开发者打开 `07-下一步行动与决策.md`,看到:
   - 5 项决策摘要(每项 1-2 句)
   - 链接到 `.xyz-harness/2026-06-04-workflow-storage-and-verification/spec.md`(相对路径)
   - Out-of-scope 列表(nested workflow / 硬 maxAgents / 重命名 / 真正 GC)
6. 开发者点击 spec 链接,看到完整的 FR-1 设计 + AC + 业务用例 UC-1
7. 开发者用 `git log --follow extensions/workflow/src/orchestrator.ts` 找到 Phase 3 的 commit,看到 PR 链接
8. 开发者读 PR description + commit message,理解"为什么 external pointer"(避免 GC 的设计成本,follow subagent mem-session 模式)
9. 开发者有完整决策脉络,可放心改 / refactor / 反向 review

**Alternative Paths:**
- **AP-5.1**: 开发者直接查 `git log` → 找到 commit message 提到 spec,点进去
- **AP-5.2**: 开发者查 `git blame` → 找到具体行,看到 "FR-1.1" 注释引用,跳到 spec
- **AP-5.3**: 开发者用 grep 找 `workflow-state-link` → 在代码和 doc 中都能找到

**Exception Paths:**
- **EP-5.1**: 调研链断裂(部分 docs 缺失)→ 至少 07 还在,作为入口
- **EP-5.2**: spec.md 缺失 → 至少 doc 摘要还在,作为"待恢复 spec" 提示

**Postconditions:**
- 开发者有完整决策脉络,无需开会问 "当初为啥这么改"
- 新成员可在 onboarding 阶段读完 docs/ 即可理解 workflow 设计历史
- 重构时可对照 spec + 调研链,避免 reverse engineering 决策

**Module Boundaries:**
- `docs/workflow-research/`: 调研链时间线
- `docs/workflow-research/07-下一步行动与决策.md`: 决策摘要 + 链接
- `.xyz-harness/2026-06-04-workflow-storage-and-verification/`: 工作流产出物
- `git log`: 不可变历史

**Coverage:**
| Spec AC | Coverage |
|---------|----------|
| AC-5.1 | Main Flow steps 5-6 |
| AC-5.2 | (Phase 1 完成,本 UC 引用) |
| AC-5.3 | (无 ADR 创建,Main Flow 未涉及) |

---

## 覆盖映射表

| UC | 主要 spec AC | 次要 spec AC |
|----|-------------|-------------|
| UC-1 | AC-1.1, AC-1.2 | AC-1.3 |
| UC-2 | AC-2.1, AC-2.5, AC-2.6 | AC-2.2, AC-2.3, AC-2.4 |
| UC-3 | AC-3.1, AC-3.2 | AC-3.4 |
| UC-4 | AC-4.1, AC-4.2, AC-4.6 | AC-4.3, AC-4.4, AC-4.5 |
| UC-5 | AC-5.1 | — |

**总覆盖:** UC-1..UC-5 覆盖 spec AC 中 1.x, 2.x, 3.x, 4.x, 5.x 全部 5 个 FR 域。无遗漏 FR。
