---
verdict: pass
---

# Non-Functional Design — 5 维度评估

> 5 个维度评估 spec.md 提出的 5 项 FR 的非功能影响。聚焦"为什么这样设计"而非实现细节。

---

## 1. 稳定性(Stability)

**影响面:** 中。

- **External State Pointer(FR-1)**: 引入新存储路径(外部文件 + pointer entry)。风险点:外部文件被误删/损坏。缓解: `state_lost` 终态(FR-1.6)+ `ctx.ui.notify` 警告 + `reconstructState` 不抛错。
- **True Approval Gate(FR-2)**: 替换 `auto` 模式行为(从 AI 自治 → UI confirm)。风险点: 无 UI 场景下行为变化。缓解: `ctx.hasUI` 显式降级(FR-2.5),RPC 模式行为不变。
- **Soft 500 Warning(FR-4)**: 新增 callback 注入模式。风险点: callback 内部 throw 影响 dispatch 循环。缓解: 实现时 `try/catch` 包裹 callback(plan BG1-T3 边界处理)。
- **Verification Gate(FR-3)**: 纯提示词注入,无 hook。**对系统稳定性零影响**(不改 orchestrator 行为)。

**结论:** 整体稳定性影响可控。`state_lost` 终态 + `hasUI` 降级 + `try/catch` 包裹 callback 三层防护。

---

## 2. 数据一致性(Data Consistency)

**影响面:** 中。

- **External State Pointer 写入路径**:
  - 写外部文件: `appendFile` 是 atomic single-write(内核保证 `< PIPE_BUF` 一次 syscall 即原子,JSONL 一行通常 < 4KB,适用)
  - 写 pointer entry: `pi.appendEntry` 走 Pi 平台的 session JSONL 持久化(已存在的可靠机制)
  - **顺序保证**: 先写文件,后写 pointer entry。rebuild 时 pointer 指向的文件**总是**至少有 1 行(刚写入的)
  - **崩溃恢复**: 如果在写文件后、写 pointer 前崩溃 → 重建时找不到 pointer entry → instance 不存在 → 用户重跑(acceptable 数据丢失)
- **sessionApprovals 一致性**:
  - 内存 Set 写入 `workflow-approval-memory` entry: 先 add,后 append
  - session_start 重建: 从历史 entries 重建 Set
  - **崩溃恢复**: 如果在 add 后、append 前崩溃 → 下次 session_start 时 Set 缺一项 → 第二次跑会再次弹 confirm(保守行为,可接受)
- **YAML frontmatter 安全性**: spec.md / plan.md / use-cases.md 等的 frontmatter 改动通过 git commit 走标准审查流程,无运行时影响。
- **并发控制**: 同一 Pi 进程内,workflow run 串行(已有 lock)。`persistState` 不会被并发调用,**不**需要 mutex。

**结论:** 数据一致性通过"先写源数据,后写 pointer/entry"顺序保证,崩溃恢复保守可接受。

---

## 3. 性能(Performance)

**影响面:** 低-中。

- **`persistState()` 改动**: 每次 O(n_instances) 写操作。n 通常 < 5(同时跑的 workflow 数),单次 < 10ms(spec FR-1.7 性能预算)。**比旧实现更慢**(旧实现只写 session JSONL,新实现要写外部文件 + pointer entry),但**常量因子** < 2x。
- **`reconstructState()` 改动**: 每次 O(n_links) 读操作。n 通常 < 50(历史 workflow 数),单次 < 50ms(spec FR-1.7 性能预算)。**比旧实现更快**(旧实现要解析整条 JSONL entry,新实现只解析文件内容 + dedup pointer)。
- **External state file 累积**: 外部文件按 `runId` 命名,用户不主动删除就一直存在。`fs.readdirSync(sessionDir/workflow-state).length` 在 100+ 时单次 read 仍 < 100ms(内核缓存)。
- **Approval Memory 累积**: `workflow-approval-memory` entries 按 workflow name 累加。100 个不同 workflow = 100 条 entry × ~100B = 10KB。可忽略。
- **Soft Warning callback 性能**: `maybeEmitSoftWarning()` 单次调用只 1 个 if + 1 个 bool check,O(1) 开销。`pi.sendUserMessage` 是异步非阻塞,不阻塞 dispatch 循环。
- **YAML 解析性能**: 不适用(本 spec 不涉及 YAML 改动)。

**结论:** 性能整体在 spec 预算内,无瓶颈。`persistState` 略慢(可接受),`reconstructState` 略快(可接受),两者平衡。

---

## 4. 业务安全(Business Safety)

**影响面:** 中。

- **Skill 文件作为 AI 行为指令(FR-3)**: `workflow-script-format/SKILL.md` 是 AI 写 workflow 脚本的 prompt 源。Verification Patterns 章节教会 AI"如何写可验证的脚本",**不是**直接控制 AI 行为(没有 runtime 强制)。
  - **风险**: AI 忽略 verification 规则 → workflow 仍是不可靠的
  - **缓解**: FR-3.3 显式声明"no orchestrator hook",保持 AI 主导性。spec 不强制,因为强制会改变 Pi agent loop 设计(超出 scope)
- **Approval Gate 实际效用(FR-2)**: `ctx.ui.confirm` 是真实 UI 阻塞,用户必须 y/n 才能继续。**比 AI 自治更安全**(避免 AI 误跑消耗 budget)。但**不**防御所有风险(用户按 y 也可能误批准)。
- **tmp workflow 特殊处理(FR-2.3)**: tmp workflow 永远弹 confirm,**不**记忆。降低"tmp 模板被记住后再次滥用"风险。
- **Force mode 显式提示(FR-2.4)**: `confirmSkipped: true` 在 renderCall 中显示,让用户看到"这个 workflow 是 force 跑的,没有 confirm"。
- **Soft Warning 不阻断(FR-4)**: 警告**不** throw,workflow 继续跑。用户决定 abort 仍是手动行为。

**结论:** 业务安全通过"UI confirm + session memory + tmp 特殊 + 显式 force 提示 + soft warning" 5 层防护,符合"轻量、可逆、用户主导"原则。

---

## 5. 数据安全(Data Security)

**影响面:** 低。

- **外部 state 文件位置**(`{sessionDir}/workflow-state/{runId}.jsonl`): 跟随 session 目录,与 session JSONL 同级。session 目录权限遵循 Pi 平台约定(用户私有,`~/.pi/agent/sessions/`)。无新增权限风险。
- **敏感信息处理**:
  - workflow state 包含:`runId` / `name` / `status` / `callCache`(`AgentResult`)/ `trace`(`ExecutionTraceNode`)/ `scriptResult`(`unknown`)/ `budget`
  - **可能包含敏感内容**:`callCache` 中的 `AgentResult.content` 是 AI 生成的文本,可能含用户 prompt 注入的敏感数据(API key、密码)
  - **缓解**: 状态文件**不**比 session JSONL 更敏感(旧实现就是这样),权限一致。**不**额外加密。
- **文件操作权限**:
  - 写入:`fs.appendFile` 创建文件(若不存在)或追加(若存在)。文件系统 umask 决定权限(默认 0644 / dir 0755)
  - 读取:`fs.readFileSync` 走当前用户权限
  - 错误处理:`reconstructState` 遇到 EACCES 走 `ctx.ui.notify` 警告路径,跳过
- **Approval Memory entries**(`workflow-approval-memory`): 只含 `workflowName` + `approvedAt` ISO timestamp。无敏感内容。
- **Soft Warning 内容**(`pi.sendUserMessage`): 包含 `runName` + `usedTokens` + `maxTokens`。`runName` 是用户起的 workflow 名(可能含敏感项目名),但本身是已存在的 session JSONL 内容,无新增风险。

**结论:** 数据安全风险与现有 session JSONL 一致,无新增风险点。`reconstructState` 显式处理 EACCES 错误。

---

## 总结

| 维度 | 影响 | 关键缓解 |
|------|------|----------|
| 稳定性 | 中 | state_lost 终态 + hasUI 降级 + try/catch 包裹 callback |
| 数据一致性 | 中 | 写顺序保证(源数据先,pointer 后)+ 崩溃恢复保守可接受 |
| 性能 | 低-中 | spec FR-1.7 预算 < 10ms / < 50ms,无瓶颈 |
| 业务安全 | 中 | 5 层防护(UI confirm + memory + tmp + force 提示 + soft warning) |
| 数据安全 | 低 | 跟随 session 目录权限,与旧实现一致 |

**整体:** 5 个维度影响均在可接受范围,无新风险点,无性能瓶颈。设计可安全进入 Phase 3 dev。
