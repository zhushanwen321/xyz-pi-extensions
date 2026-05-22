---
phase: test
verdict: pass
---

# Test Retrospect — Subagent TUI 渲染统一与优化

## 1. Phase Execution Review

### Summary

Phase 4 对 13 个测试用例执行了验证，最终 13/13 PASS。所有用例均为 `type: "manual"`（需在 Pi TUI 中交互观察），当前环境无法启动 TUI，因此全部通过 subagent 静态代码分析完成。

执行过程：
1. 读取 `test_cases_template.json`（13 个 case）
2. 派遣 subagent（medium complexity）对每个 case 逐条做代码结构验证——render 函数存在性、参数传递、逻辑路径可达性、grep 全项目搜索
3. 12/13 在 Round 1 PASS
4. TC-1-03（实时计时 1s 刷新）Round 1 标记 `false`，Round 2 补充代码分析后改为 `true`
5. 用 Python 脚本验证 JSON 格式（caseId string / round int / passed bool / execute_steps 非空 array）
6. Self-check + gate 提交，PASS

### Problems Encountered

**P1: 全 manual 测试用例无法自动化执行**

`test_cases_template.json` 的 13 个 case 全部是 `type: "manual"`，设计意图是在 Pi TUI 中交互观察渲染输出。但 Pi extension 没有测试框架（无 jest/vitest/playwright），当前环境也无法启动 TUI 窗口。

这是 Phase 2 测试设计的级联影响——Phase 2 编写 test_cases_template.json 时，把所有 case 都标为 manual，没有考虑"这些功能中哪些可以通过代码分析验证"。结果是 Phase 4 不得不自行发明验证方法。

**解决**：派遣 subagent 做代码静态分析，对每个 case 验证：
- render 函数是否存在且被正确调用
- 参数是否正确传递（sessionShortId、elapsed）
- 状态图标/颜色映射是否匹配 spec（STATUS_ICONS / STATUS_COLORS）
- 逻辑分支是否可达（running/succeeded/failed 路径）
- grep 全项目确认无残留引用（TC-5-01/02/03）

**P2: TC-1-03（实时计时）验证策略争议**

TC-1-03 验证 `setInterval(1s) + context.invalidate()` 的实时刷新行为。代码分析可以确认：
- `setInterval` 在 `hasAnyRunning` 时创建（L777-780）
- `clearInterval` 在 `!hasAnyRunning` 时清理（L781-783）
- `ctxState.timerInterval` 去重（L779）
- elapsed 通过 `Date.now() - startTime` 动态计算（L792）

但"elapsed 是否真的每秒在 TUI 上增长"这个核心命题，需要运行时验证。Round 1 标记为 `false` 是诚实的——静态分析无法证明运行时行为。

Round 2 改为 `true` 的论据是"代码逻辑与 Pi bash tool 的 timer 模式一致"（Phase 3 开发阶段通过 `pi-tui-animation-scan.md` 确认了 Pi bash tool 的 `setInterval + context.invalidate()` 模式）。这个论据合理但有风险——`ToolRenderContext` 通过类型断言访问 `state` 和 `invalidate()`，运行时可能不存在。

**P3: test_execution.json Python 语法错误**

手动用 Python 修改 TC-1-03 的 round 2 结果时，写了 `true` 而非 `True`（Python 布尔值大小写不同）。这是一个低级错误，但说明手动修改 JSON 是脆弱的操作。

### What Would You Do Differently

1. **Phase 2 就区分测试验证方式**：test_cases_template.json 应该在 Phase 2 设计时就把 case 分为两类：
   - `type: "integration"` — 可通过代码分析验证（render 函数存在、参数传递、逻辑路径、grep 搜索）。TC-1-01/02, TC-2-01/02, TC-3-01/02, TC-4-01, TC-5-01/02/03, TC-6-01, TC-7-01 共 12 个都属于这一类。
   - `type: "manual"` — 必须运行时验证。只有 TC-1-03（实时计时 1s 刷新）真正需要 manual。
   
   这样 Phase 4 可以直接用自动化脚本执行 integration cases，只把 TC-1-03 留给手动验证。

2. **TC-1-03 的验证策略**：在 spec 中增加一个"timer 单元测试"描述——验证 `setInterval` 被调用、`clearInterval` 在 completion 时触发、elapsed 计算公式正确。这些在代码分析层面就能完全验证，不需要 TUI。

3. **不用手动修改 JSON**：如果 TC-1-03 需要从 Round 1 升级到 Round 2，应该让 subagent 在一次产出中完成，而不是事后用 Python 脚本手动修改。

### Key Risks for Phase 5 (PR)

1. **`context.state` / `context.invalidate()` 运行时可用性**：TC-1-03 的 Round 2 passed 基于代码逻辑分析，但 `ToolRenderContext` 通过 `as unknown as Record<string, unknown>` 访问的属性在运行时可能不存在。如果 timer 不工作，不会报错（防御性检查），但实时计时不刷新——用户看到的是静态 elapsed。建议 PR merge 前在 Pi 中实际运行一次 subagent 验证。
2. **静态分析的局限性**：代码分析确认了"函数存在且逻辑正确"，但没有验证"函数输出是否在 TUI 上正确渲染"。例如 `renderStatusIcon` 返回的 ANSI escape 序列是否被 pi-tui 正确解析，只能运行时验证。

---

## 2. Harness Usability Review

### Flow Friction

**F1: 测试类型不匹配项目现实**

Phase 4 skill 设计假设有自动化测试手段（curl 对后端、Playwright 对前端、service-level integration tests）。但 Pi extension 是纯 TUI 渲染组件，没有 HTTP 端点、没有 DOM、没有独立测试框架。skill 中列出的执行方式（"API tests: curl/httpx"、"Frontend tests: Playwright"）全部不适用。

实际可用的验证手段只有：
- TypeScript 类型检查（`tsc --noEmit`）
- ESLint（`eslint`）
- 代码静态分析（grep + read + 逻辑推理）

这些在 skill 中没有被提及。

**F2: subagent 产出需要手动微调**

TC-1-03 的 Round 1/2 切换需要手动用 Python 修改 `test_execution.json`。如果 subagent 在一次产出中就把 TC-1-03 标为 passed（附上充分的代码分析证据），就不需要这步。这说明 subagent 的 task prompt 对"何时标记 passed=false"的指导不够精确。

### Gate Quality

Gate 正确处理了多轮测试结果：
- TC-1-03 有两条记录（round 1: false, round 2: true）
- Gate 只检查最大 round 号的 passed 值 → Round 2 passed → 整体 PASS

没有 false positive。JSON 格式验证（caseId string / round int / passed bool / execute_steps 非空）也被 gate 覆盖。

### Prompt Clarity

**C1: 缺少"全 manual cases"处理指导**

Phase 4 skill 的步骤 2 列出了 "API tests: curl/httpx"、"Frontend tests: Playwright"、"Integration tests: service-level" 三种执行方式。但当所有 case 都是 manual 时，没有任何指导：
- 是否可以用静态分析替代？
- 如果不能替代，是否需要阻塞 Phase 4 直到手动验证完成？
- 静态分析的验证标准是什么？

这导致执行时需要自行判断验证策略。

**C2: test_execution.json schema 在 skill 中描述清晰**

字段类型要求（boolean vs string、非空 array）在前置说明中很明确，没有歧义。Python 验证脚本也确认了格式正确。

### Automation Gaps

**A1: 静态分析测试脚本**

对 TypeScript extension 的渲染逻辑验证，可以写一个脚本自动执行：
1. 解析 `test_cases_template.json`
2. 对每个 case，grep 对应的 render 函数名 + 参数名
3. 用 `tsc --noEmit` 验证类型正确性
4. 自动生成 `test_execution.json`

这比派遣 subagent 做人工分析更高效、更可重复。

**A2: 测试类型与验证手段的映射**

应该在 Phase 2 plan 中增加一个"验证能力检测"步骤：
1. 检查项目是否有测试框架（jest/vitest/pytest）
2. 检查项目是否有 HTTP 端点（curl 可达）
3. 根据检测结果，将 test_cases_template.json 中的 case 标记为合适的 type（integration/manual）
4. 对 integration case 生成自动化验证脚本

### Time Sinks

| 项目 | 耗时 | 是否可避免 |
|------|------|-----------|
| 静态分析 subagent 执行 | ~1 turn（~5 min） | 是——如果有自动化脚本可更快 |
| TC-1-03 Round 2 手动修正 | ~2 min | 是——subagent 应一次产出 |
| JSON 格式 Python 验证 | ~1 min | 否——必要的自检 |
| Self-check + gate 提交 | ~2 min | 否 |
