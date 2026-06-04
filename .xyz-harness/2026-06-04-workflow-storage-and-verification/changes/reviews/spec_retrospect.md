---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-04-workflow-storage-and-verification"
harness_issues:
  - "Skill injection failure (Phase 1 init) — extension reported 'will be re-injected via before_agent_start on the next turn' but re-injection did not happen. Future phases should detect and gracefully handle missing skill context without relying on auto-retry."
  - "Pre-commit hook runs tsc --noEmit on docs-only commits. This caused a false positive in this worktree (no node_modules). Suggest: detect changes to docs/ and .md only and skip tsc, OR check for node_modules existence before running tsc."
  - "Skill recommends 'one question at a time' but for batch-clarification scenarios (5+ related decisions), batching is more efficient. Add a 'batch mode' opt-in to the skill checklist for users who clearly want to answer in bulk."
  - "Spec is 18KB — approaching the size where splitting into per-FR subdocs becomes useful. The 'local-override' rule says '>1000 字优先拆分子文档' but Chinese chars vs English bytes differ. Need clearer split threshold (e.g., >20KB or >5 distinct FRs)."
---

# Phase 1 Retrospect — Spec

## Phase Execution Review

### Summary

Phase 1 完成了 `@zhushanwen/pi-workflow` 5 个 FR 的 spec 编写,涵盖 External State Storage(替代 GC)、True UI Approval Gate(替代 AI 自治决定)、Verification Gate(纯提示词注入)、Soft 500 maxAgents warning、文档沉淀。

关键决策(均与用户确认):
- 节点是 JS 脚本写死的(非每次动态生成),验证逻辑在脚本中体现而非 hook
- External state pointer 存到 session 目录(跟 subagent mem-session 同策略)
- 状态机新加 `state_lost` 终态(8 个 status,非 7 个)
- 本地类型 stub 需同步更新(FR-2.6 强制约束)
- AgentPool 用 callback 模式不直接持有 ExtensionAPI

工作量估算 5-7 天,实际 spec 编写 + 2 轮 review + commit + push 用了约 1.5 小时(纯 spec 阶段)。

### Problems Encountered

**P1: v1 review 抓出 1 个 MUST_FIX(行号引用错)**
- 我在 spec 的 "Code-Level Assumption Verification Summary" 自报"所有接口名/枚举值/字段名均经代码验证",但 FR-3.4 引用的 `state.ts:78-86` 实际是 `WorkflowInstance` 接口体(ExecutionTraceNode 在 65-75)。这是**自报与实际不符**的失误。
- 影响:实现者按 spec 行号找接口会找错。
- 解决:v1 review → v2 fix(2 个 LOW + 1 INFO 一并修正)。

**P2: v1 review 抓出 AgentPool 设计缺陷**
- FR-4.3 代码示例 `this.pi.sendUserMessage` 假设 AgentPool 持有 ExtensionAPI 引用,但实际 AgentPool 构造函数只接 `maxConcurrency`。
- 影响:实现时直接抄代码会 typecheck 失败。
- 解决:v1 指出 → v2 改 callback 模式(`onSoftLimitReached`),并加 AC-4.6 显式约束。

**P3: 工作流中无 `node_modules` 导致 pre-commit hook 报 TS2688**
- worktree 环境的 `node_modules` 不存在(只在 main worktree),`tsc --noEmit` 报"Cannot find type definition file for 'node'"。
- 影响:第一次 commit 被 hook 阻止,需要先 `pnpm install`。
- 解决:`pnpm install --frozen-lockfile` 后 commit 通过。

**P4: 首次 push 需要 `-u` 设置 upstream**
- 影响:1 次重试。正常现象,不算问题,记下提醒。

### What Would You Do Differently

1. **逐项 grep 验证行号引用,不要凭"已经读过"**: 写 spec 时我已经读过 `state.ts` 全文件,但在 spec 中引用行号时未逐项 `grep -n "interface ExecutionTraceNode" state.ts` 确认。第一次写 spec 时应**在 self-check 之前**做一次专门的行号 grep 验证。
2. **AgentPool 这类已有 API surface 变化需要单独 trace**: 涉及 `agent-pool.ts` 改动的 FR(FR-4)应该**主动** dispatch subagent 读 `agent-pool.ts` 完整内容,而不是只读相关行(我读了相关行没读 constructor,导致漏掉 API 注入问题)。
3. **在 5 个 Q 的开头就提及"节点静态/动态"**: 用户在第二轮回复 #3 时提出"节点是 JS 脚本提前写好的还是动态生成"这个关键概念,我应该**第一轮**就问清。这能避免多一轮往返。

### Key Risks for Later Phases

| 风险 | 触发条件 | 缓解 |
|------|----------|------|
| **FR-1.4 reconstructState 重写影响 backwards compat** | 老 session 中有 `workflow-state` 旧 entries 时,rebuild 逻辑要 ignore 但不抛错 | plan 阶段加专门的 backwards compat 集成测试,模拟老 session JSONL |
| **FR-2.6 stub 更新影响其他扩展 typecheck** | `shared/types/mariozechner/index.d.ts` 是共享 stub,加 `confirm`/`select`/`input` 后其他 7 个扩展的 typecheck 也需验证 | plan 阶段跑 `pnpm -r typecheck` 全量验证,不只 workflow 包 |
| **FR-3 提示词效果难 e2e 验证** | SKILL.md / promptGuidelines 改动无法直接断言 AI 行为变化 | test 阶段设计专门的"AI-generated workflow 脚本"测试:模拟 AI 收到 promptGuidelines 后的输出,断言包含 verify 节点 |
| **FR-4 callback 模式引入新错误面** | `onSoftLimitReached` 回调可能 throw 而无 try/catch,影响 dispatch 循环 | plan 阶段加 callback error handling 设计(包裹 try/catch,log 而不 rethrow) |
| **持久化层变动需要灰度** | 已有用户的 session 在升级后第一次 reconstruct 行为未经验证 | plan 阶段设计"渐进式 fallback"——reconstructState 兼容老格式 + 新格式,平滑过渡 |

---

## Harness Usability Review

### Flow Friction

**F1: Phase 1 skill 注入失败后未重试**
- 现象:`coding-workflow-init` 返回 "Phase 1 skill injection failed — it will be re-injected via before_agent_start on the next turn",但下一轮(以及后续轮次)都未自动重试注入。
- 影响:我必须在系统 prompt 中手动找 skill 入口(通过 skill list 找到 brainstorming skill),并按其内容执行。**整个 Phase 1 我没有显式收到 Phase 1 skill 的注入,完全靠通用知识 + skill 列表推断。**
- 严重度:中。skill 失败后没 fallback,等同于"无 skill 引导"。

**F2: pre-commit hook 对 docs-only commit 过度严格**
- 现象:`pre-commit` 跑 `tsc --noEmit`,但本 commit 只改 `.md` 文件,无 `.ts` 变更。
- 影响:本工作流是 docs-only(没有代码改动),`tsc` 完全无意义,仍然跑(并失败,因为没 node_modules)。
- 严重度:低-中。`pnpm install` 解决,但每次新建 worktree 都要做。

**F3: skill 推荐的"1 Q at a time"与效率冲突**
- 现象:skill checklist 强调"one question per message",但本次需求用户明显想批量回答(他一次回 1+2+3+4+5 全给方向)。
- 影响:如果我严格 1 Q 一轮,Phase 1 会多花 5 轮往返。
- 严重度:低。skill 没明确说"用户偏好批量时可以批量",导致我做判断时犹豫。

### Gate Quality

- **正确识别 untracked files** — `.xyz-harness/` 目录创建后未 commit,gate FAIL 直到 commit。✅ 准确。
- **正确识别 spec.md `verdict=pass`** — ✅
- **正确识别 spec_review verdict + must_fix** — ✅
- **没识别"spec 是否真的完整"** — 这次 spec 写完 + 2 轮 review + gate PASS,但 gate 不验证 spec 内容质量,只验证 frontmatter + 文件存在 + review 存在。这正确(质量由 review subagent 把关),但用户如果跳过 review 直接 gate,也能过。这是**设计上的合理 trade-off**。

### Prompt Clarity

**PC1: brainstorming skill 边界清晰** — Step 1-10 流程清楚,deliverable 模板(spec.md 6 大元素)明确,不需要解释"spec 是什么"。

**PC2: review subagent task prompt 模板清楚** — agent / model / task / output 都有明确格式,直接照抄就能 dispatch。

**PC3: gate check 输出格式清晰** — PASS/FAIL + 哪几项 FAIL,一眼看出。

**PC4: skill 没说 retrospect 怎么触发** — Phase 1 gate PASS 后,用户提示我"execute the retrospect"。说明 retrospect 不是 gate-pass 自动触发的,需要用户主动说。这与 skill 中"Auto Mode: coding-workflow 扩展自动管理 loop"有出入。

### Automation Gaps

**AG1: skill 注入失败时无 retry/fallback** (见 F1)

**AG2: pre-commit hook 不区分 docs-only vs code 变更** (见 F2)

**AG3: retrospect 触发依赖用户/扩展,不在 spec 流程内** — Phase 1 spec 完成 → gate PASS → 应该自动 dispatch retrospect subagent。但本次是用户手动要求。如果用户忘了,retrospect 永远缺失。

**AG4: 没自动 diff spec 行号 vs 实际代码** — 行号引用错误(见 P1)是 spec 返工的常见源头。harness 可以在 spec 写完后自动跑一次 "extract all `state.ts:N` / `index.ts:N` references and verify" 脚本,提前抓行号错。这能省一轮 review。

### Time Sinks

| 耗时项 | 时长 | 原因 | 可优化 |
|--------|------|------|--------|
| 5 个 Q 的设计 + 回答 | ~10 min | 用户思维清晰,无歧义来回 | 已经较优 |
| 读 8 个源码文件 | ~5 min | 假设审计需要(实际是 spec 准备) | 不可压缩,verification 必须 |
| spec 写 v1 | ~20 min | 18KB 中文 + 5 个 FR + AC 矩阵 | 可拆 subagent 写,但单 agent 一气呵成更连贯 |
| v1 review | ~3 min | subagent 跑 review | 已经自动化 |
| 修 v1 + 重写 v2 review | ~5 min | 4 个问题 + 1 个 design advisory | 已经较优 |
| pnpm install | ~1 min | worktree 无 node_modules | 见 AG2 |
| git commit + push | ~1 min | 正常 | 已经最优 |

总 ~45 min(其中等待 subagent + 实际写 spec 占大部分),合理范围。

---

## Improvement Suggestions (for harness maintainers)

1. **Skill 注入失败 fallback**: `coding-workflow-init` / `coding-workflow-gate` 失败时,应该在 system prompt 显式包含 skill 内容(冗余),或者明确说"无法注入,主 agent 请 read skills/{name}/SKILL.md 自行加载"。

2. **pre-commit hook 区分 commit 类型**:
   ```bash
   if ! git diff --cached --name-only | grep -q "\.ts$"; then
     echo "[pre-commit] 无 .ts 变更,跳过 tsc"
     exit 0
   fi
   ```
   或更细致:如果有 `package.json` 变更或 `tsconfig.json` 变更也跑。

3. **Retrospect 自动触发**: spec gate PASS 后,coding-workflow 扩展应该自动 dispatch retrospect subagent(已声明"Auto Mode: coding-workflow 扩展自动管理 loop"),不需要用户手动要求。

4. **Spec 行号自动验证**: gate check 时加一个 step:用 Python/JS 脚本提取 spec.md 中所有 `{file}:{N}` 或 `{file}:{N-M}` 模式,对每个文件 `grep -n` 验证。建议加入 `check_gate.py`。

5. **Batch question opt-in**: brainstorming skill 加一段:"当用户明显想批量回答(在 issue/需求中预先给 5+ 个决策方向),主 agent 可以一次性问完所有澄清问题,不严格 1 Q 一轮。"
