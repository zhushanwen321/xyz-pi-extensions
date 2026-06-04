---
verdict: pass
---

# E2E Test Plan — workflow-storage-and-verification

> 5 项 FR(External State / Approval Gate / Verification Gate / Soft 500 Warning / doc)的 E2E 测试场景。覆盖 spec 中 24 个 AC 的所有验收点。

## Test Scenarios

### E2E-1: External State Storage end-to-end

**Objective:** 验证 FR-1(External State Pointer)整个数据流: 跑 workflow → 文件写入 → pointer 写入 → 关闭 Pi → 重启 session → reconstruct 成功。

**Scenario:**
1. 启动新 Pi session,在 `~/.pi/agent/sessions/` 下创建 session 目录
2. 调 `workflow-run` tool 跑 workflow `e2e-1-test`(已注册),该 workflow 有 3 个 agent 节点
3. workflow 跑完,3 次 `persistState()` 被调用
4. 验证:
   - `~/.pi/agent/sessions/{sessionId}/workflow-state/{runId}.jsonl` 存在,文件大小 > 0
   - JSONL 文件可解析,行数 ≥ 3
   - 主 session JSONL 中存在 3 条 `workflow-state-link` entries(每条含 `runId`、`path`、`updatedAt`)
   - 主 session JSONL **不**包含 `workflow-state` 旧类型 entries
5. 关闭 Pi session(模拟 kill -9 或正常退出)
6. 重启 Pi session,加载相同 session
7. 验证:
   - `session_start` handler 触发 `reconstructState()`
   - 之前跑的 workflow instance 正确恢复(status / callCache / trace / scriptResult)
   - `ctx.ui.notify` **未**被调用(因为文件完整,无丢失)

**Spec AC coverage:** AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-1.5

---

### E2E-2: Approval Gate with real UI confirm

**Objective:** 验证 FR-2 真 UI confirm 行为,包含 session memory、tmp 特殊、force 模式、hasUI 降级。

**Scenario:**
1. 启动新 Pi session(`ctx.hasUI = true`)
2. AI 调 `workflow-run` 跑 `e2e-2-test`,`mode="auto"`,精确匹配
3. 验证:
   - `ctx.ui.confirm` 被调 1 次,参数 title="Run workflow?", message 含 workflow 名
   - 模拟用户按 n → 返回 `status: "declined"`,workflow 未跑
4. 重试,模拟用户按 y → workflow 跑,`sessionApprovals` 含 `e2e-2-test`
5. 同 session 再调 `workflow-run` 跑 `e2e-2-test` 第二次
6. 验证:
   - `ctx.ui.confirm` **不**被调(走 cache)
   - workflow 直接跑
7. 关闭 session,重启(同一 session 文件)
8. 验证:
   - `session_start` 后 `sessionApprovals` 从 `workflow-approval-memory` entries 重建
   - 跑 `e2e-2-test` 第三次,confirm **不**被调

**Sub-scenario 2A: force 模式**
- 调 `mode="force"`,验证 `ctx.ui.confirm` **不**被调,`details.confirmSkipped: true`

**Sub-scenario 2B: tmp workflow**
- 调 `workflow-generate` 生成 tmp workflow,`source="tmp"`
- 跑该 tmp workflow,验证 `ctx.ui.confirm` 被调(首次)
- 再跑同 tmp workflow,验证 confirm 仍被调(tmp 不进 memory)

**Sub-scenario 2C: hasUI=false 降级**
- 切换到 RPC 模式(`ctx.hasUI = false`)
- 调 `mode="auto"`,验证 `ctx.ui.confirm` **不**被调,`pi.sendUserMessage` 被调(旧行为)

**Spec AC coverage:** AC-2.1, AC-2.2, AC-2.3, AC-2.4, AC-2.5, AC-2.6, AC-2.7

---

### E2E-3: Verification Gate via prompt injection

**Objective:** 验证 FR-3 提示词注入对 AI 写脚本的影响,以及 orchestrator / worker-script **不**被改动。

**Scenario:**
1. 检查 git diff:`extensions/workflow/src/orchestrator.ts` + `extensions/workflow/src/worker-script.ts` 与 main 分支对比,**0 改动**
2. 检查 `extensions/workflow/skills/workflow-script-format/SKILL.md`:
   - 包含 "## Verification Patterns" 章节
   - 包含 "Pattern A" 代码示例(Node-Internal Verification)
   - 包含 "Pattern B" 代码示例(Follow-up Verify Node)
3. 检查 `extensions/workflow/src/tool-generate.ts`:
   - `promptGuidelines` 数组长度 ≥ 之前的 + 1
   - 新增项含 "verifiable" 关键词
4. 模拟 AI 收到 system prompt(包含 promptGuidelines) + SKILL.md 上下文,生成一个简单 workflow 脚本
5. 验证生成的脚本包含至少 1 个 verify 节点(Pattern A 或 Pattern B 任一)

**Sub-scenario 3A: verifyStrategy 字段**
- 检查 `state.ts` 的 `ExecutionTraceNode` interface 有 `verifyStrategy?: "internal" | "follow-up" | "none"`
- 检查 `serializeInstance` 输出**不**含 verifyStrategy(JSON.stringify 验证)
- 跑一个 workflow,实例在内存 trace 中可设置 `verifyStrategy` 但不持久化到外部文件

**Spec AC coverage:** AC-3.1, AC-3.2, AC-3.3, AC-3.4

---

### E2E-4: Soft 500 maxAgents warning

**Objective:** 验证 FR-4 soft warning 行为,包含单次触发、跨 workflow 独立、callback 模式、cache hit 不计数。

**Scenario:**
1. 注册一个 600-agent workflow `e2e-4-big`
2. 跑该 workflow,AgentPool 实例 `pool1` 创建
3. 监控 `pi.sendUserMessage` 调用:
   - 第 1-500 个 agent:0 次
   - 第 501 个 agent:1 次(softWarningSent 翻转)
   - 第 502-600 个 agent:0 次(softWarningSent=true 守)
4. 验证:
   - `pi.sendUserMessage` 总共 1 次被调
   - 消息内容: `[workflow:e2e-4-big] Reached 500 agent calls. Budget: ${used}/${max} tokens. Consider aborting if this is unintended.`
   - workflow **未**抛错,正常完成(或继续跑)
5. 跑第二个 workflow `e2e-4-small`(20 个 agent)
6. 验证:
   - `pi.sendUserMessage` 未被调(没到 500)
   - AgentPool `pool2.totalCallCount` 从 0 开始(per-instance)

**Sub-scenario 4A: cache hit 不计数**
- 跑 workflow,同一 callId 调 agent() 5 次
- 验证: `totalCallCount` 只 +1(cache hit 4 次不计数)

**Sub-scenario 4B: callback 模式**
- 验证 AgentPool 构造函数接 `onSoftLimitReached` 回调
- 验证 AgentPool **不**直接持有 `ExtensionAPI` 引用(无 `this.pi`)
- 验证 callback 在 orchestrator 层注入(orchestrator.pi 持有)

**Spec AC coverage:** AC-4.1, AC-4.2, AC-4.3, AC-4.4, AC-4.5, AC-4.6

---

### E2E-5: Doc 沉淀

**Objective:** 验证 FR-5 文档沉淀,6 个月后回看代码的开发者能找到完整决策链。

**Scenario:**
1. 验证文件存在: `docs/workflow-research/07-下一步行动与决策.md`
2. 文件内容检查:
   - 标题含"决策摘要"
   - 至少 5 项决策摘要
   - 链接到 `.xyz-harness/2026-06-04-workflow-storage-and-verification/spec.md`(相对路径)
   - "Out-of-scope" 列表: nested workflow / 硬 maxAgents / auto/force 重命名 / 真正 GC
   - "Why no ADR" 章节
3. 验证 `CONTEXT.md` 含 4 个新术语:
   - External State Pointer
   - State-Lost
   - Approval Memory
   - Verification Strategy
4. 验证 `docs/adr/` 目录**无**新增文件(本 spec 决策都不需要 ADR)

**Spec AC coverage:** AC-5.1, AC-5.2, AC-5.3

---

### E2E-6: Test suite & typecheck

**Objective:** 验证 AC-6.1 / 6.2 / 6.3 全部通过。

**Scenario:**
1. `pnpm --filter @zhushanwen/pi-workflow test`:
   - 现有 140 个测试全绿
   - 新增 ≥ 13 个单元测试全绿
   - 总数 ≥ 153
2. `pnpm --filter @zhushanwen/pi-workflow typecheck`:
   - 0 错误
   - (本测试覆盖了 stub 同步更新后的 typecheck 验证)
3. `pnpm -r typecheck`:
   - 0 错误(覆盖其他 7 个扩展,因为 shared stub 被改动)
4. `pnpm --filter @zhushanwen/pi-workflow lint`:
   - 0 错误(无 `any` / 无 magic number / 品味规则全过)

**Spec AC coverage:** AC-6.1, AC-6.2, AC-6.3

---

## Test Environment

| 项目 | 配置 |
|------|------|
| Pi 运行时 | v0.x(本地开发用 `pnpm install` + workspace 链接) |
| Node.js | v24.x |
| TypeScript | strict mode + taste-lint rules |
| 测试框架 | vitest(`npx vitest run` 或 `pnpm --filter ... test`) |
| Mock 工具 | vitest 内置 `vi.fn()` / `vi.useFakeTimers()` / 手写 mock |
| 文件系统 | `os.tmpdir()` + cleanup(测试不污染真实 session) |
| TUI 测试 | E2E 场景用 `ctx.hasUI = true` 模拟;`ctx.ui.confirm` mock 返回 `Promise<boolean>` |

## Test Execution Order

1. **Phase 1**: 单元测试(`vitest run`)— E2E-1 ~ E2E-6 中所有 AC 都有对应单元测试
2. **Phase 2**: 集成测试(同进程内 workflow 跑完整个流程)— E2E-1 / E2E-2 / E2E-4
3. **Phase 3**: 全包 typecheck / lint
4. **Phase 4**: 端到端手动验证(开发者在真实 Pi session 中跑 workflow)— 由用户决定是否需要

## 退出标准

- 6 个 E2E 场景全通过
- 单元测试覆盖率 ≥ 90%(核心文件: `state.ts` / `orchestrator.ts` / `index.ts` / `agent-pool.ts`)
- 0 typecheck / lint 错误
- 0 个 P0/P1 评审 issue
