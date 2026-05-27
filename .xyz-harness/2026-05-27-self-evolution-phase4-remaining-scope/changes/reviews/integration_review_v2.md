---
review:
  type: code_review
  round: 2
  timestamp: "2026-05-27T23:55:00"
  target: "integration review v2 — evolution-engine/ MUST FIX 修复验证"
  verdict: fail
  summary: "v1 MUST FIX #1 (extractReportSubset 死代码) 已修复。v1 MUST FIX #2 (command handler 不支持 merge-reviewer) 未修复。Tool 路径完整可用，command 路径仍然阻塞 UC-5。"

review_metrics:
  files_reviewed: 4
  issues_carried: 5
  must_fix_resolved: 1
  must_fix_remaining: 1
  low_carried: 2
  info_carried: 1

statistics:
  total_issues: 5
  must_fix: 1
  must_fix_resolved: 1
  low: 2
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "evolution-engine/src/judge.ts:51-69 (extractReportSubset)"
    title: "merge-reviewer 分支不可达，数据链断裂"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "skills 分支改为显式 if(target==='skills'){...return}，merge-reviewer 分支从死代码变为可达的 fallthrough。数据链完整。"

  - id: 2
    severity: MUST_FIX
    location: "evolution-engine/src/index.ts:383-391 (/evolve command handler)"
    title: "command handler 接口不支持 merge-reviewer"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    resolution: null

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
    title: "TEMPLATE_DIR fallback 依赖 process.cwd()"
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

# Integration Review v2

## 评审记录

- 评审时间：2026-05-27 23:55
- 评审类型：集成审查 v2（MUST FIX 修复验证）
- diff 范围：HEAD~3..HEAD，evolution-engine/ 目录
- 前置审查：v1 verdict=fail, must_fix=2

---

## MUST FIX #1 修复验证：extractReportSubset

### 修复前 (v1)

```typescript
// skills 分支是隐式 fallthrough，没有 guard return
if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
if (report.skill_health != null) subset.skill_health = report.skill_health;
if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
return subset;  // ← merge-reviewer 代码在此之后，死代码
```

### 修复后 (v2)

```typescript
if (target === "skills") {                           // 显式 guard
    if (report.skill_stats != null) subset.skill_stats = report.skill_stats;
    if (report.skill_health != null) subset.skill_health = report.skill_health;
    if (report.actionable_issues != null) subset.actionable_issues = report.actionable_issues;
    return subset;                                   // 显式 return
}

// target === "merge-reviewer"                        ← 现在 fallthrough 到此处
if (report.tool_stats != null) subset.tool_stats = report.tool_stats;
if (report.error_stats != null) subset.error_stats = report.error_stats;
if (report.user_patterns != null) subset.user_patterns = report.user_patterns;
return subset;
```

### 控制流追踪

```
target = "merge-reviewer"
  → skip "all" (line 41)
  → skip "claude-md" (line 45)
  → skip "skills" (line 57)          ← 显式 guard，不会误入
  → reach merge-reviewer block (line 67)
  → extract: tool_stats + error_stats + user_patterns  ✅
  → return subset
```

### 数据链完整性验证

| 集成点 | 期望数据 | 实际数据 | 匹配 |
|--------|---------|---------|------|
| extractReportSubset("merge-reviewer") | tool_stats + error_stats + user_patterns | 同左 | ✅ |
| merge-reviewer.txt 模板输入 | 同上字段 | 同上 | ✅ |
| TARGET_TEMPLATE["merge-reviewer"] | "merge-reviewer.txt" | "merge-reviewer.txt" | ✅ |
| 模板文件存在 | src/templates/merge-reviewer.txt | 存在 (50行) | ✅ |

**结论：MUST FIX #1 已修复。数据链 F3 完整。**

---

## MUST FIX #2 修复验证：command handler

### 当前代码 (index.ts:383-391)

```typescript
let target: "all" | "claude-md" | "skills" = "all";
let since = "7d";

for (const part of parts) {
    if (part === "all" || part === "claude-md" || part === "skills") {
        target = part;                               // ← "merge-reviewer" 不在条件中
    } else if (part.match(/^\d+d$/)) {
        since = part;
    }
}
```

### 控制流追踪

```
用户输入: /evolve merge-reviewer
  → parts = ["merge-reviewer"]
  → "merge-reviewer" !== "all" && !== "claude-md" && !== "skills"
  → target 保持 "all"                                ← 退化到默认值
  → handleEvolve({ target: "all", since: "7d" }, dirs)
  → buildJudgeInput(report, "all", tmpDir)
  → extractReportSubset(report, "all")
  → return report (全量数据)                         ← 不是 merge-reviewer 分析
```

### 影响分析

| 路径 | merge-reviewer 支持 | 状态 |
|------|-------------------|------|
| Tool: `evolve` tool (index.ts:129) | target 含 "merge-reviewer"，type assertion 含 "merge-reviewer" | ✅ 可用 |
| Command: `/evolve merge-reviewer` (index.ts:383) | target 类型 + 条件判断均不含 | ❌ 退化到 "all" |

**结论：MUST FIX #2 未修复。Command 路径 UC-5 不通。**

修复方式明确：

```typescript
// 修改 1：类型扩展
let target: "all" | "claude-md" | "skills" | "merge-reviewer" = "all";

// 修改 2：条件扩展
if (part === "all" || part === "claude-md" || part === "skills" || part === "merge-reviewer") {
    target = part;
}
```

---

## 额外变更验证 (非 MUST FIX 相关)

### commands.ts:117-121 — ANALYZER_SCRIPT 存在性检查

```typescript
if (!existsSync(ANALYZER_SCRIPT)) {
    throw new Error(
        `Session analyzer not found at ${ANALYZER_SCRIPT}. ` +
        `Please install pi-session-analyzer first.`
    );
}
```

- 增量变更，早失败模式 ✅
- 不影响数据链路 ✅

### commands.ts:239-244 — apply 列表显示 diff preview

```typescript
const diffPreview = suggestion.diff
    ? `  Diff preview:\n  ${suggestion.diff.split("\n").slice(0, 10).join("\n  ")}`
    : "";
```

- 纯展示改进，不影响数据流 ✅
- 10 行截断合理 ✅

### types.ts — JudgeInput.target 扩展

```typescript
target: "all" | "claude-md" | "skills" | "merge-reviewer";
```

- 类型层已支持 ✅（与 command handler 运行时行为不一致，但类型定义本身正确）

### integration.test.mts — srcDir 修复

```typescript
const srcDir = new URL("../src", import.meta.url).pathname;
```

- 移除硬编码路径 ✅
- 使用 import.meta.url 相对定位 ✅

---

## 与 Spec / Use-Cases 对照 (更新)

| UC/AC | 要求 | v1 状态 | v2 状态 | 说明 |
|-------|------|---------|---------|------|
| UC-5 / Command 入口 | `/evolve merge-reviewer` 识别参数 | ❌ | ❌ | command handler 未修改 |
| UC-5 / Tool 入口 | Tool call target="merge-reviewer" | ❌ | ✅ | EvolveParams + type assertion 均已扩展 |
| UC-5 / extractReportSubset | 提取 tool_stats + error_stats + user_patterns | ❌ | ✅ | skills guard 修复后 merge-reviewer 可达 |
| UC-5 / 模板映射 | merge-reviewer → merge-reviewer.txt | ✅ | ✅ | 无变化 |
| UC-1 | Tool/Command → buildJudgeInput → runJudge | ✅/❌ | ✅/❌ | Tool ✅, Command ❌ (同 UC-5) |
| UC-4 | session_start → monitor → notify | ✅ | ✅ | 无变化 |
| UC-2 / UC-3 | apply / rollback | ✅ | ✅ | 无变化 |

---

### 结论

**需修改后重审。** 2 条 MUST FIX 中修复了 1 条（#1 extractReportSubset 死代码 → 可达），1 条未修复（#2 command handler）。

UC-5 的数据链在核心处理层（extractReportSubset → buildJudgeInput → runJudge → parseJudgeOutput）已完整。唯一阻塞点是 command handler 的参数解析不支持 `"merge-reviewer"`。但 **Tool 路径完全可用**：AI 通过 `evolve` tool 调用 `target="merge-reviewer"` 可以正常走完整个 UC-5 链路。

如果决定 UC-5 仅通过 Tool 路径使用（command 路径降级为便捷入口），可将 #2 降级为 LOW。否则仍需修复。

### Summary

v2 集成审查：MUST FIX #1 (extractReportSubset 死代码) 已修复，数据链完整。MUST FIX #2 (command handler 不支持 merge-reviewer) 未修复，command 入口 `/evolve merge-reviewer` 退化到 "all"。Tool 路径完整可用。verdict: fail, must_fix_remaining: 1。
