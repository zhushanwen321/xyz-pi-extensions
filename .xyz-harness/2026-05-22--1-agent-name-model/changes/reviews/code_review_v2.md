---
verdict: "pass"
must_fix: 0
review:
  type: code_review
  round: 2
  timestamp: "2026-05-22T22:00:00"
  target: "subagent/src/render.ts + subagent/src/index.ts (commit a5414e8)"
  verdict: "pass"
  summary: "编码评审完成，第2轮，0条MUST FIX，通过"

statistics:
  total_issues: 6
  must_fix: 0
  must_fix_resolved: 2
  low: 2
  info: 2

issues:
  - id: 1
    severity: MUST_FIX
    location: "render.ts:renderSingleCollapsedText L429-L430"
    title: "F1: Single 模式缺少 Line 2——agent+model+elapsed 在 Line 1 上，未分离为 Line 2"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 2
    severity: MUST_FIX
    location: "index.ts:renderResult L550-L554"
    title: "F2: 实时计时器未实现——无 setInterval + context.invalidate()，elapsed 只计算一次"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 3
    severity: LOW
    location: "index.ts:renderResult L574-L578"
    title: "Chain 模式总体 icon 使用硬编码 icon/color map 而非 renderStatusIcon()"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2

  - id: 4
    severity: LOW
    location: "render.ts:renderChainCollapsedText L462-L463"
    title: "renderChainCollapsedText 接收预着色 icon: string，内部 step icon 却用 renderStatusIcon——不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: INFO
    location: "index.ts:capturedSessionId L103"
    title: "capturedSessionId 闭包在多 session 场景下存在竞争隐患"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: INFO
    location: "render.ts:renderStatusIcon L54"
    title: "ThemeColorParam 类型断言可接受，但类型安全性可通过 const 断言改进"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 编码评审 v2

## 评审记录

- 评审时间：2026-05-22 22:00
- 评审类型：编码评审（模式二）
- 评审对象：`changes/evidence/test_results.md`（测试验证证据）+ 对应代码变更
- 变更范围：commit `a5414e8`（fix: header 3-layer structure + live timer）、`d4530d3`（feat: unify TUI rendering）
- 输入文件：`spec.md`、`plan.md`、`test_results.md`、实际代码变更

---

## 总览

| 项目 | 状态 |
|------|------|
| v1 MUST_FIX 修复 | 2/2 已解决（F1 header 分层，F2 实时计时器） |
| v1 LOW 修复 | 1/2 已解决（#3 Chain icon 硬编码），#4 未修复 |
| v1 INFO 修复 | 0/2 已解决（均为 INFO，不阻塞） |
| 类型检查 | 0 errors |
| ESLint | 0 errors（51 既有 warning，无新增） |
| 文件变更 | `render.ts` +133/-86，`index.ts` +0/-134 |
| **最终结论** | **通过** |

---

## v1 MUST_FIX 逐条验证

### Issue #1 (F1): Single 模式 Line 2 分离 — ✅ RESOLVED

**修复验证（render.ts L423-425）：**
```typescript
let text = `${icon} ${theme.fg("toolTitle", theme.bold("single"))}${theme.fg("accent", idPart)}`;
text += `\n  ${theme.fg("accent", view.name)}  ${theme.fg("dim", view.model ?? "")}`;
if (durationStr) text += `  ${theme.fg("dim", durationStr)}`;
```

| Spec 要求 | 实现 | 符合? |
|-----------|------|-------|
| Line 1: `⏳ single #0196a3b2` | `${icon} single${#id}` | ✅ |
| Line 2: `  general-purpose  ds-flash/high  3.2s` | `\n  view.name  view.model  [duration]` | ✅ |
| Line 2 缩进 2 空格 | `\n  ` | ✅ |
| Line 2 dim 颜色 | `theme.fg("dim", ...)` | ✅ |

**结论：** 三层 Header 结构已正确实现。agent name 和 model 从 Line 1 移到了 Line 2。

---

### Issue #2 (F2): 实时计时器 — ✅ RESOLVED

**修复验证（index.ts L534-548）：**

```typescript
const ctxState = (context as unknown as Record<string, unknown>).state as Record<string, unknown> | undefined;
const ctxInvalidate = (context as unknown as Record<string, unknown>).invalidate as (() => void) | undefined;
const hasAnyRunning = details.results.some((r) => r.exitCode === -1);
if (hasAnyRunning && ctxState && !ctxState.timerInterval && ctxInvalidate) {
    ctxState.timerInterval = setInterval(() => ctxInvalidate(), 1000);
}
if (!hasAnyRunning && ctxState?.timerInterval) {
    clearInterval(ctxState.timerInterval as ReturnType<typeof setInterval>);
    ctxState.timerInterval = undefined;
}
```

| Plan 关键模式 1 要求 | 实现 | 符合? |
|----------------------|------|-------|
| `context.state` 存储 timer state | `ctxState` 从 `context.state` 读取 | ✅ |
| `setInterval(() => context.invalidate(), 1000)` | `setInterval(() => ctxInvalidate(), 1000)` | ✅ |
| `!state.interval` 启动防护 | `!ctxState.timerInterval` guard | ✅ |
| 完成时清理 interval | `!hasAnyRunning && ctxState?.timerInterval` → clearInterval | ✅ |
| `context.isError` 停止条件 | 未使用 `isError`，用 `exitCode !== -1` 等价判断 | ✅ |
| `options.isPartial` 判断运行状态 | 改用 `details.results.some(r => r.exitCode === -1)` | ✅（功能等价） |
| `context.onAbort` 清理 | ❌ **未实现** | ⚠️ 缺失 |

**核心计时功能已正确实现。** `context.onAbort` 清理缺失属于资源泄漏防护，不是核心功能缺陷——如果 session 被 abort，`hasAnyRunning` 会变为 false，interval 仍在下一轮 render 时被清理。但 abort 到下一轮 render 之间可能存在空窗期。

**等级判定校准：** `onAbort` 缺失不会导致"功能不可用或数据错误"——核心计时功能正常。属于额外防护，不构成 MUST FIX。

**结论：** 核心功能已实现，降级为 LOW 观察。

---

## v1 LOW/INFO 问题状态

### Issue #3: Chain 总体 icon 硬编码 — ✅ RESOLVED

index.ts 中已将：
```typescript
const iconMap = { running: "\u23F3", succeeded: "\u2705", failed: "\u274C" };
const colorMap = { running: "warning", succeeded: "success", failed: "error" };
const icon = theme.fg(colorMap[overallStatus] as "warning", iconMap[overallStatus]);
```
替换为：
```typescript
const icon = renderStatusIcon(overallStatus, theme);
```
`renderStatusIcon` 已 `export`，实现与 render.ts 共享。✅

### Issue #4: renderChainCollapsedText 接收 `icon: string` — ❌ 未修复

函数签名保持 `icon: string`（预着色 icon），仍由调用者传入。但调用者已改用 `renderStatusIcon()` 生成 icon，因此输入一致性有所改善。仍属 LOW 风格问题。

### Issue #5: capturedSessionId 多 session 竞争 — ❌ 未修复

模块级 `const capturedSessionId = { value: "" }` 仍为共享可变状态。当前单 session 环境安全。INFO。

### Issue #6: ThemeColorParam 类型断言 — ❌ 未修复

仍使用 `(STATUS_COLORS[status] ?? "muted") as ThemeColorParam`。INFO。

---

## 测试证据评估

**test_results.md 内容分析：**

| 检查项 | 结果 | 说明 |
|--------|------|------|
| TypeScript 类型检查 | 0 errors | 类型安全通过 |
| ESLint | 0 errors, 51 warnings | 全部为既有 `no-magic-numbers`，无新增 |
| 文件变更覆盖 | ✅ | render.ts (+133/-86) + index.ts (+0/-134) 覆盖了所有计划 task |
| 运行时测试 | ❌ 不可行 | Pi 扩展无运行时测试框架，仅通过类型安全验证 |

**证据充分性评估：** test_results.md 证明了代码变更的类型安全和 lint 合规性。F1/F2 的功能正确性需通过代码审查（本报告已执行）和人工观察验证。缺少 `context.onAbort` 清理的运行时覆盖——但 Pi 扩展环境中无法编写单元测试，这是已知约束。

---

## 新发现的问题

本次审查未发现新的 MUST FIX 问题。以下为新增观察：

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 7 | LOW | index.ts:L534-L537 | `context` 类型断言 `as unknown as Record<string, unknown>` 脆弱 | 期望 Pi API 为 renderResult context 提供 `state`/`invalidate` 类型。当前 cast 可工作但类型不安全 |
| 8 | LOW | index.ts:L534-L548 | F2 缺失 `context.onAbort` 清理——abort 后 interval 可能继续运行 | 参考 plan 关键模式 1：增加 `context.onAbort?.(() => { clearInterval(...) })` 确保 abort 时清理 |

#### 等级判定校准

| 问题 | 评估 | 理由 |
|------|------|------|
| #2 onAbort 缺失（原 MUST FIX） | 降为 LOW | 核心计时功能正常，无数据丢失/功能不可用。abort 后 interval 可能短暂残留但在完成 render 时仍会清理 |
| #7 类型断言 | LOW | 当前能工作，但类型不安全。属于防护性改进 |
| #8 onAbort 缺失（新） | LOW | 与 #2 同一根本原因，但原 MUST FIX 核心已修复 |

**判断口诀应用：** "如果该问题在生产环境会导致功能不可用或数据错误，就必须标 MUST FIX。"
- F1 已修复，header 显示正确 → 功能可用
- F2 已修复，elapsed 每秒刷新 → 功能可用
- onAbort 缺失 → 异常路径防护，非功能不可用

---

## 结论

**通过。** v1 的 2 条 MUST FIX（F1 header 分层、F2 实时计时器）均已正确修复。代码无类型错误，无新增 lint 问题。v1 LOW 问题 #3（Chain icon 硬编码）已修复，#4（参数风格）和 #5/#6（INFO）未处理但均为非阻塞项。

### Summary

编码评审完成，第2轮通过，0条MUST FIX。
