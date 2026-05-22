---
phase: dev
verdict: pass
---

# Dev Retrospect — Subagent TUI 渲染统一与优化

## 1. Phase Execution Review

### Summary

Phase 3 在 2 个文件（`render.ts` + `index.ts`）上完成 subagent TUI 渲染管线重构，净减 74 行（+147/-221）。主功能 commit `d4530d3` 和修复 commit `a5414e8` 共 2 个 dev commit。

核心交付：
- `render.ts`：新增 `STATUS_ICONS`/`STATUS_COLORS`/`renderStatusIcon()` 三件套，所有 render 函数 header 重构为三层结构，活动流过滤 thinking 并显示 text output（`TEXT_PREVIEW_LINES=3`），提取 `CHAIN_COLLAPSED_ITEM_COUNT=5` 常量
- `index.ts`：移除 `collect_subagent` 工具注册（~140 行），统一 renderCall 格式（`⏳ mode #sessionID`），renderResult 集成 `setInterval(1s) + context.invalidate()` timer 和 session ID 传递

### Problems Encountered

**P1: Subagent abort（~10 min 浪费）**

本 phase 按 plan 设计走"复杂路径"（subagent-driven dev），向 BG1 派遣 subagent 执行 render.ts Tasks 1-3。subagent 返回结果后，BG2 Task 6 的 subagent 被系统 abort。原因未确定——可能是并发 semaphore 限制或上下文过大。被迫回退到主 agent 直接编码，之前 subagent 的产出也被废弃（因为 render.ts 被改为 head+tail 拼接策略）。

**根因**：2 个文件的实际改动复杂度低于 plan 预估（plan 按 7 tasks 拆分，实际每个 task 都是同一文件的不同区域），subagent 调度的 overhead 超过了并行收益。

**P2: Unicode 匹配失败（~8 min 浪费）**

使用 `edit` 工具替换 `render.ts` 中的旧图标字符（如 `✗`、`✓`），oldText 中的 Unicode 转义 `\u2717` 无法匹配文件中实际的 UTF-8 字节序列。反复尝试 3 种转义写法均失败。

**解决**：改用 `head -N file > /tmp/head.ts` + 手写 tail + `cat head tail > file` 的策略，绕过 edit 工具的精确匹配限制。对 <600 行文件的批量修改，write 重写比 edit 逐块替换更可靠。

**P3: 对象字面量内变量声明（~3 min）**

在 `pi.registerTool({...})` 对象字面量内部声明 `let capturedSessionId = ""` 导致 TS1005。JavaScript/TypeScript 对象字面量内不允许 `let`/`const` 声明——这不是什么边界情况，是基本功错误。解决：将变量提升到 `subagentExtension` 函数闭包顶层，和 `spawnManager` 同级。

**P4: ToolRenderContext 类型断言（~5 min）**

`context.state` 和 `context.invalidate()` 不在 `ToolRenderContext` 类型定义中。通过 `as unknown as Record<string, unknown>` 双重断言绕过。这不是一个安全的做法——如果 Pi 运行时 context 不暴露这些属性，timer 不会启动但也不会报错（代码有防御性 `undefined` 检查），功能静默失效。

**P5: Code review 发现 2 条 MUST FIX**

1. `renderSingleCollapsedText` 把 agent name + model + elapsed 全放在 Line 1，违反 spec 三层 header 结构——编码时没有严格对照 spec 的 line-by-line 格式要求。
2. `renderResult` 的 `_context` 参数完全被忽略，没有实现 `setInterval + context.invalidate()`——plan 中明确描述了 timer 模式，但编码时遗漏了实现。

两条都是 spec 合规问题，说明编码时对 spec 的逐条验证不够严格。

### What Would You Do Differently

1. **直接用主 agent 编码**：2 文件、~400 行变更的 TUI 渲染任务，主 agent 直接编码效率最高。subagent 调度在这个规模上只会增加 abort 风险和上下文传递成本。
2. **对 spec 做 line-by-line 验证**：编码完成后，按 spec F1-F8 逐条对照检查渲染输出，而不是等 code review 发现。每个 F 条目是否在代码中有对应的实现，header 的每行是否精确匹配 spec 描述。
3. **先读 types.ts 再用类型断言**：`ToolRenderContext` 的实际字段应该先从 Pi 源码确认，再决定用类型断言还是另找方案。先假设可用再用 `as unknown as` 绕过，是不严谨的做法。

### Key Risks for Later Phases

1. **`context.state` / `context.invalidate()` 运行时可用性**：类型断言绕过了编译检查，运行时可能不存在。Phase 4 的静态分析无法验证这一点。
2. **`capturedSessionId` 多 session 共享**：`{ value: "" }` 对象在所有 session 间共享，最后一个 execute 调用覆盖之前的值。当前单 session 安全，多 session 时 `renderCall` 和 `renderResult` 可能显示错误的 session ID。
3. **`renderStatusIcon` 的 `ThemeColorParam` 断言**：如果 Pi 更新 `ThemeColor` 联合类型添加或移除值，断言不会报错但运行时可能 `theme.fg()` 抛异常。

---

## 2. Harness Usability Review

### Flow Friction

**F1: Review subagent YAML frontmatter 格式（~2 min/phase）**

Code review subagent 输出嵌套 YAML 格式（`review: { verdict: ... }`），gate 需要 flat 格式（`verdict: pass`）。这需要手动 `sed` 修正 frontmatter。Phase 1-3 累计出现 3 次，共 ~6 min。这是一个系统性问题——review subagent 的 task prompt 没有包含显式 YAML 模板。

**F2: Subagent abort 无重试机制**

BG2 Task 6 的 subagent 被 abort 后，没有自动 fallback 或重试。需要手动判断是否回退到主 agent 编码，重新构建上下文。如果 harness 能提供 abort 后的自动 fallback（"subagent X 失败，回退到主 agent 执行"），会减少决策中断。

### Gate Quality

Gate 在第一轮正确识别了 code review 的 2 条 MUST FIX，拒绝通过。修复后第二轮正确 PASS。Gate 的 spec 合规检查有效，没有 false positive。

### Prompt Clarity

**C1: "复杂路径"定义与实际脱节**

Plan 有 7 个 tasks（>4），按 skill 定义应走"复杂路径"（subagent-driven dev）。但实际改动只涉及 2 个文件、每个文件的修改区域有强依赖（同文件的不同函数需要共享常量和类型），串行 subagent 的 overhead 远大于并行收益。

建议：路径选择应基于"涉及文件数"而非"task 数"。2 文件以下始终走简单路径。

**C2: 缺少 Pi extension 特殊性说明**

Pi extension 没有测试框架（无 jest/vitest），类型检查（`tsc --noEmit`）和 lint（`eslint`）是唯一可自动化的验证手段。Phase 3 skill 没有提到这一点，导致"测试"步骤需要自行判断验证方式。

### Automation Gaps

**A1: Review frontmatter 格式**

每个 phase 的 review subagent 都输出嵌套 YAML，需要手动修正为 flat 格式。建议在 review subagent 的 task prompt 中嵌入显式模板：
```yaml
---
verdict: pass
must_fix: 0
---
```

**A2: Edit 工具的 Unicode 处理**

edit 工具对 Unicode 字符（⏳✅❌○）的匹配不可靠。当 oldText 包含非 ASCII 字符时，匹配可能因编码差异失败。建议对含 Unicode 的文件优先使用 `write` 重写，或提供 `whitespace-fixer` 类的预处理。

### Time Sinks

| 项目 | 耗时 | 是否可避免 |
|------|------|-----------|
| Subagent abort + 回退到主 agent | ~10 min | 是——直接用主 agent 编码 |
| Unicode 匹配失败 + 改用 write 策略 | ~8 min | 是——一开始就用 write |
| TypeScript 类型断言调试 | ~5 min | 部分——如果先读 types.ts 可减少 |
| Code review MUST FIX 修复 | ~10 min | 部分——如果编码时做 spec 逐条验证 |
| Review frontmatter 手动修正 | ~2 min | 是——在 task prompt 中加模板 |
