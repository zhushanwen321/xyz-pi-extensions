---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-27T23:15:00"
  target: "integration review — evolution-engine/ 跨模块数据流与接口契约"
  verdict: fail
  summary: "2条MUST FIX：数据链断裂（extractReportSubset merge-reviewer 分支不可达，继承自 BLR #1 未修复）；command handler 接口不一致（继承自 BLR #3 未修复）。1条LOW（日志并发写入），1条INFO（无集成测试）。需修改后重审。"

review_metrics:
  files_reviewed: 5
  issues_found: 5
  must_fix_count: 2
  low_count: 2
  info_count: 1
  duration_estimate: "1.5h"

statistics:
  total_issues: 5
  must_fix: 2
  must_fix_resolved: 0
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "evolution-engine/src/judge.ts:57-74 (extractReportSubset)"
    title: "merge-reviewer 分支不可达，数据链断裂（继承 BLR #1，未修复）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "evolution-engine/src/index.ts:346-354 (/evolve command handler)"
    title: "command handler 接口不支持 merge-reviewer（继承 BLR #3，未修复）"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: LOW
    location: "evolution-engine/src/monitor.ts:24 (createMonitorLogger)"
    title: "内联 logger 写入共享日志目录，多进程并发写入风险"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "evolution-engine/src/index.ts:19 (TEMPLATE_DIR fallback)"
    title: "TEMPLATE_DIR fallback 依赖 process.cwd()，部署环境不确定时不可用"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "evolution-engine/ (跨模块)"
    title: "无跨模块集成测试覆盖 UC-5 全链路"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# Integration Review v1

## 评审记录

- 评审时间：2026-05-27 23:15
- 评审类型：集成审查（Integration Review）
- 评审对象：`evolution-engine/` — 跨模块数据流、接口契约、集成点
- 前置 BLR 状态：**已通过（v1），但 #1 和 #3 未修复**

### 被审查的跨模块集成点

| # | 上游模块 | 下游模块 | 数据/调用传递 | 涉及 UC |
|---|---------|---------|--------------|---------|
| F1 | index.ts (tool/command) | commands.ts (handleEvolve) | 参数传递 | UC-1, UC-5 |
| F2 | commands.ts (handleEvolve) | judge.ts (buildJudgeInput) | target + report | UC-1, UC-5 |
| F3 | judge.ts (extractReportSubset) | judge.ts (buildJudgeInput → tmp file) | 报告子集写入 | UC-5 |
| F4 | judge.ts (buildJudgeInput) | judge.ts (runJudge → pi subprocess) | 临时文件 + 模板 | UC-1, UC-5 |
| F5 | judge.ts (runJudge) | judge.ts (parseJudgeOutput) | LLM stdout → 结构化建议 | UC-1, UC-5 |
| F6 | judge.ts (parseJudgeOutput) | state.ts (savePending) | EvolutionSuggestion[] | UC-1, UC-2 |
| F7 | index.ts (session_start) | monitor.ts (checkAutoTriggerRules) | 事件触发 | UC-4 |
| F8 | monitor.ts (flag files) | index.ts (renderAutoTriggerHint) | 文件系统 → 通知 | UC-4 |
| F9 | commands.ts (handleEvolveApply) | applier.ts (applySuggestion) | 审批 → apply | UC-2 |
| F10 | commands.ts (handleEvolveRollback) | applier.ts (rollbackSuggestion) | index → rollback | UC-3 |

---

## 逐项集成分析

### F1: Tool/Command 参数 → handleEvolve

**Tool 路径（`index.ts:129-146`）：**

```typescript
execute: async (_toolCallId, params, ...) => {
    return await handleEvolve(
        { target: params.target as "all" | "claude-md" | "skills" | "merge-reviewer", ... },
        dirs,
    );
},
```

- Schema `EvolveParams` 包含 `"merge-reviewer"` ✅
- Type assertion 正确 ✅
- `handleEvolve` 接收完整类型 ✅

**Command 路径（`index.ts:346-354）：**

```typescript
let target: "all" | "claude-md" | "skills" = "all";
// ...
if (part === "all" || part === "claude-md" || part === "skills") {
    target = part;
}
```

- **问题：** `target` 类型声明不含 `"merge-reviewer"`，条件判断也不含 `"merge-reviewer"` ❌
- **影响：** 用户输入 `/evolve merge-reviewer` 时，target 保持默认 `"all"`，UC-5 主路径不通
- **评级：MUST FIX** — 接口不一致，tool 已支持但 command 不支持

---

### F2: handleEvolve → buildJudgeInput

```typescript
// commands.ts:126
const judgeInput = buildJudgeInput(
    report,
    params.target === "all" ? "all" : params.target,  // 类型: JudgeInput["target"]
    dirs.tmpDir,
);
```

- 类型传递正确 ✅
- 但 `params.target` 如果为 `"merge-reviewer"`，传给 `buildJudgeInput` 后如何？见 F3。

---

### F3: extractReportSubset → buildJudgeInput（核心数据链）

这是整个 Integration Review **最关键的数据流**。

```typescript
// judge.ts:57-74
function extractReportSubset(report, target) {
    if (target === "all") return report;
    const subset = {};
    if (target === "claude-md") {
        // ... 提取 token_stats + user_patterns + actionable_issues + tool_stats + error_stats
        return subset;  // ← 提前返回
    }
    // target === "skills" (此处有注释，但也是 fallthrough for unknown targets)
    if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
    if (report.skill_health != null) subset.skill_health = report.skill_health;
    if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
    return subset;  // ← 在此处返回！后续代码不可达

    // DEAD CODE — target === "merge-reviewer"
    if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
    if (report.error_stats != null) subset.error_stats = report.error_stats;
    if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
    return subset;
}
```

**数据流追踪（当 target="merge-reviewer"）：**

```
User → /evolve merge-reviewer
  → handleEvolve → buildJudgeInput(report, "merge-reviewer", tmpDir)
    → extractReportSubset(report, "merge-reviewer")
      → 落入 skills 分支（else 隐式分支）
      → 提取: skill_stats + skill_health + actionable_issues
      → 未提取: tool_stats + error_stats + user_patterns ❌
  → writeFileSync(reportPath, JSON.stringify(subset), ...)
  → TARGET_TEMPLATE["merge-reviewer"] → "merge-reviewer.txt"
  → runJudge(input, templateDir)
    → readFileSync(templatePath) → merge-reviewer.txt 内容 ✅
    → readFileSync(input.reportPath) → 错误子集 ❌（含 skill_stats 而非 tool_stats）
    → spawn pi 进程，模板（期望 tool_stats）收到错误数据
    → LLM 基于 skill 数据生成 "合并效率" 建议 → 无意义输出
```

**结论：** UC-5 的数据链在第一跳就断裂了。extractReportSubset 的 merge-reviewer 分支是**死代码**，因为位于 `return subset;` 之后。**这是 BLR #1 的同一问题，仍未修复。**

- **评级：MUST FIX** — 功能失效，merge-reviewer 整个功能形同虚设

---

### F4-F5: buildJudgeInput → runJudge → parseJudgeOutput

**TARGET_TEMPLATE 映射：**

```typescript
// judge.ts:23
const TARGET_TEMPLATE = {
    all: "session-quality.txt",
    "claude-md": "prompt-optimize.txt",
    skills: "skill-health.txt",
    "merge-reviewer": "merge-reviewer.txt",
};
```

- `"merge-reviewer" → "merge-reviewer.txt"` 映射正确 ✅
- 4 个模板文件全部存在于 `src/templates/` ✅

**模板文件存在性检查（runJudge）：**

```typescript
// judge.ts:217
if (!existsSync(templatePath)) {
    throw new Error(`Judge template not found: ${templatePath}`);
}
```

- runtime 检查，早失败，正确 ✅

**parseJudgeOutput target 校验：**

```typescript
// judge.ts:299
let target = String(record.target);
if (target === "skills") target = "skill";
if (target !== "claude-md" && target !== "skill") continue;
```

- `EvolutionSuggestion.target` 定义为 `"claude-md" | "skill"`（types.ts:22），不包含 `"merge-reviewer"`
- 但 merge-reviewer 模板的输出 schema 也限制 target 为 `"claude-md"` 或 `"skill"`（模板要求 LLM 输出这两个值）
- 所以模板输出格式与 parseJudgeOutput 校验一致 ✅
- 设计上，suggestion.target 表示**修改目标位置**（哪里需要改），而非**分析来源**（什么分析产生的）
- **结论：这不是集成问题。** merge-reviewer 模板产生的建议会正确通过校验。

---

### F7-F8: session_start → monitor.ts

```
session_start event
  → checkAutoTriggerRules(evolutionDir)
    → loadRecentDaily(dailyDir, now, 14)
    → checkTokenDecline / checkSkillDormant / checkErrorSpike
    → writeFlag / removeFlag (auto-trigger.flags/)
  → cleanExpiredFlags(evolutionDir)
  → renderAutoTriggerHint(flags) → ctx.ui.notify
```

**BLR #2 状态：已修复。** monitor.ts 不再跨扩展导入，使用内联 `createMonitorLogger`：

```typescript
// monitor.ts:12-25
function createMonitorLogger(prefix: string) {
    const logDir = join$1(homedir$1(), ".pi", "agent", "logs");
    function write(level: string, args: unknown[]) {
        if (!existsSync$1(logDir)) mkdirSync$1(logDir, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        const filePath = join$1(logDir, `${prefix}-${date}.log`);
        const ts = new Date().toISOString();
        const msg = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
        try { appendFileSync(filePath, ...); } catch { /* silent */ }
    }
    // ...
}
```

- 不再有跨扩展 import ✅
- 使用 `node:fs` 标准库 ✅
- 但写入 `~/.pi/agent/logs/` 共享目录：多个 Pi session 实例可能同时写入同一文件，`appendFileSync` 不是原子操作，日志行可能交错。**评级：LOW**
- 无日志轮转/清理机制，日志文件永久累积。**评级：LOW**

**cleanExpiredFlags 调用时序：** 在 checkAutoTriggerRules 之后调用，新写入的 flag 不会过期（cutoff 为 > 7 天前）。时序正确 ✅

**ctx.ui.notify 降级：** 无 UI 环境时 flag 仍然写入文件系统，但用户看不到通知。这是正确的降级 ✅

---

### F9-F10: handleEvolveApply / handleEvolveRollback → applier.ts → state.ts

**Apply 流程：**

```
handleEvolveApply
  → loadPending (读取 pending.json)
  → applySuggestion (备份 → diff → git commit)
  → savePending (更新 pending.json 状态)
  → appendHistory (追加到 history.jsonl)
```

**Rollback 流程：**

```
handleEvolveRollback
  → loadHistory (读取 history.jsonl)
  → rollbackSuggestion (git revert 或 copy backup)
  → appendHistory (追加 rollback 记录)
```

**集成点分析：**

| 集成点 | 数据源 | 消费者 | 状态 |
|--------|--------|--------|------|
| pending.json | savePending → writeFileSync | loadPending → readFileSync | ✅ 一致 |
| history.jsonl | appendHistory → appendFileSync | loadHistory → readFileSync → parse lines | ✅ 一致 |
| backup 文件 | applySuggestion → copyFileSync | rollbackSuggestion → copyFileSync | ✅ 一致 |

- 读写格式一致 ✅
- 错误处理：loadPending 返回 `undefined`（文件不存在），handleEvolveApply 抛错提示用户先跑 `/evolve` ✅
- **但存在一个时序/并发隐患：** 如果用户在 rollback 时 pending suggestions 尚未 review，rollback 不影响 pending。这是正确的隔离设计 ✅

---

### BLR 问题修复状态验证

| BLR # | 问题 | 期望修复 | 当前状态 | 验证 |
|-------|------|---------|---------|------|
| #1 | extractReportSubset 缺少 merge-reviewer 分支 | 新增分支 | **未修复** — 分支代码已添加但位于 `return subset;` 之后，不可达 | ❌ |
| #2 | monitor.ts 跨扩展 logger import | 内联 logger | **已修复** — monitor.ts:12-25 使用内联 createMonitorLogger | ✅ |
| #3 | /evolve command handler 不支持 merge-reviewer | 新增分支 | **未修复** — index.ts:346-354 仍只检查 3 个值 | ❌ |
| #4 | EvolveCommandParams.target 类型 | 扩展类型 | **已修复** — types.ts:90 | ✅ |
| #5 | commands.ts 缩进 | 对齐 | **已修复** — 缩进与周围代码一致 | ✅ |

**结论：** BLR #2, #4, #5 已修复。BLR #1 和 #3 **仍未修复**，作为集成问题重新标记为本报告的 #1 和 #2。

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改方向 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `judge.ts:57-74` | **extractReportSubset merge-reviewer 分支不可达（继承 BLR #1，未修复）。** 分支代码存在于 `return subset;` 之后，是死代码。当 `target="merge-reviewer"` 时落入 skills 分支，提取 `skill_stats` + `skill_health`。merge-reviewer 模板期望 `tool_stats` + `error_stats` + `user_patterns`。**数据链 UC-5 完全断裂。** | 将 merge-reviewer 分支移到 `return subset;` 之前，或重构为 switch/case 避免死代码。参考：`if (target === "merge-reviewer") { ... return subset; }` 放在 skills 分支之前。 |
| 2 | MUST FIX | `index.ts:346-354` | **`/evolve` command handler 不支持 merge-reviewer（继承 BLR #3，未修复）。** `target` 变量类型限定为 `"all" | "claude-md" | "skills"`，条件判断中缺少 `"merge-reviewer"`。用户输入 `/evolve merge-reviewer` 时 target 退化到 `"all"`。**UC-5 的 command 入口不通。** | (a) 将 `target` 类型扩展为包含 `"merge-reviewer"`；(b) 在条件判断中加入 `part === "merge-reviewer"` 分支。 |
| 3 | LOW | `monitor.ts:24` | **内联 logger 写入共享日志目录 `~/.pi/agent/logs/`。** 多个 Pi session 实例可能同时 appendFileSync 同一文件，导致日志行交错。日志文件无轮转/过期清理，长期累积。 | (a) 添加日志轮转（按文件大小或日期自动分割）；(b) 添加自动清理逻辑（保留近 30 天）；(c) 或接受当前实现——不影响功能正确性。 |
| 4 | LOW | `index.ts:19` | **TEMPLATE_DIR fallback 路径依赖 `process.cwd()`。** 当 `import.meta.url` 不可用时（bundler 模式），fallback 为 `join(process.cwd(), "evolution-engine", "src", "templates")`。如果用户从非 workspace 根目录启动 pi，此路径错误。当前主路径（import.meta.url）正常工作，fallback 很少触发。 | 移除 fallback，或改为在扩展安装时硬编码绝对路径。如果 import.meta.url 在 Pi 运行时始终可用，此问题仅为防御性代码的冗余。 |
| 5 | INFO | `evolution-engine/` | **无跨模块集成测试覆盖 UC-5（merge-reviewer）全链路。** F3 中的数据链断裂在无 E2E 测试的情况下不会被捕获。当前测试仅覆盖单元级别。 | 添加集成测试：从 buildJudgeInput → extractReportSubset → runJudge → parseJudgeOutput 的完整数据链路验证，至少验证 extractReportSubset 对不同 target 的子集提取是否正确。 |

---

#### 等级判定依据

| # | 判定依据 |
|---|---------|
| 1 | **功能失效**（判定规则 2）：merge-reviewer 路径下，代码从未被执行（死代码）。用户使用 merge-reviewer 功能时，LLM Judge 收到错误数据，产出无意义建议。 |
| 2 | **功能失效**（判定规则 2）：command handler 条件分支从未包含 merge-reviewer，用户通过 `/evolve merge-reviewer` 调用时退化到默认。UC-5 的主交互路径不工作。 |
| 3 | 不影响功能正确性，不影响数据完整性。日志行交错是展示问题，非数据问题。 |
| 4 | 主路径正常工作，fallback 很少触发。不阻塞任何功能。 |
| 5 | 流程改进建议，非当前代码缺陷。 |

---

### 与 Spec / Use-Cases 对照

| UC/AC | 要求 | 集成状态 | 说明 |
|-------|------|---------|------|
| UC-5 / Main Flow | 用户输入 `/evolve target=merge-reviewer` → 使用 merge-reviewer 模板 | ❌ | Command handler 不支持参数（#2），数据链断裂（#1） |
| UC-5 / 步骤 3 | extractReportSubset 提取 tool_stats + error_stats + user_patterns | ❌ | 实际提取了 skill_stats + skill_health（#1） |
| UC-5 / 步骤 4 | Judge 使用 merge-reviewer 模板 | ✅ | TARGET_TEMPLATE 映射正确，模板文件存在 |
| UC-1 | Tool 路径 → buildJudgeInput → runJudge → parseJudgeOutput | ✅ (tool) / ❌ (command) | Tool 路径完整，command 路径不支持 merge-reviewer |
| UC-4 | session_start → monitor → flag → notify | ✅ | 完整链路正确，BLR #2 已修复 |
| UC-2 / UC-3 | apply / rollback → applier → state | ✅ | 数据流完整，状态持久化一致 |

---

### 结论

**需修改后重审。** 2 条 MUST FIX 均为 BLR 遗留问题，#1 和 #3 未修复。这两个问题导致 UC-5（merge-reviewer 模板分析）数据链完全断裂，用户通过 command 路径无法使用该功能。建议按 #1 → #2 顺序修复：#1 导致 LLM Judge 输入错误，#2 阻塞 command 入口。

### Summary

集成审查完成，第 1 轮需重审，2 条 MUST FIX。核心发现：extractReportSubset merge-reviewer 分支是死代码（BLR #1 未修复），command handler 不支持 merge-reviewer（BLR #3 未修复）。其余集成点（session_start→monitor, apply/rollback→state→applier）验证通过。
