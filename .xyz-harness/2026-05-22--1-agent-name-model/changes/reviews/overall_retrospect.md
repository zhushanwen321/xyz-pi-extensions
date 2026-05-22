---
phase: pr
verdict: pass
---

# Overall Retrospect — Subagent TUI 渲染统一与优化（5 Phase 全覆盖）

## 项目基本信息

| 维度 | 值 |
|------|-----|
| 项目 | xyz-pi-extensions, subagent extension |
| 改动范围 | `subagent/src/render.ts` + `subagent/src/index.ts`（2 个文件） |
| 复杂度评估 | L1（不跨模块，2 文件） |
| 代码变更 | +147/-221 行，净减 74 行 |
| Dev commits | `d4530d3`（主功能）+ `a5414e8`（MUST FIX 修复） |
| PR | https://github.com/zhushanwen321/xyz-pi-extensions/pull/1 |
| CI | 无（项目未配置 GitHub Actions） |

---

## 1. Phase-by-Phase 执行回顾

### Phase 1 (Spec) — 评分：A-

**做了什么**：产出 spec.md（8 FR、6 AC、30+ checkpoint、7 constraints、Out of Scope）。通过 pi-mono bash.ts 源码扫描发现 `setInterval + context.invalidate()` timer 模式。5 轮澄清问答 + mockup 迭代。Review 2 轮 PASS。

**做对了什么**：
- Completeness check（6 元素）有效捕获了缺失的 Out of Scope 和歧义的 "N=3-5" 范围
- pi-mono 源码扫描提前验证了 timer 机制的可行性，减少了 Phase 3 的探索成本
- Spec 的 F/AC → task 映射清晰，Phase 2 几乎不需要回溯

**做错了什么**：
- Review subagent 的 YAML frontmatter 格式不匹配（嵌套 vs flat），需要手动修正。这是 5 个 phase 中持续出现的系统性问题
- Spec review 中一次 subagent dispatch 因 API 429 失败，需要手动补写

**如果重来**：在 review subagent 的 task prompt 中嵌入显式 YAML 模板，一次解决格式问题。

### Phase 2 (Plan) — 评分：B+

**做了什么**：产出 plan.md（7 tasks、3 BG、Wave 1-3 调度）+ e2e-test-plan.md（8 场景）+ test_cases_template.json（13 用例）。Review 3 轮 PASS。

**做对了什么**：
- BG1/BG2 的 Execution Group 拆分有效隔离了并行依赖
- Wave 调度发现了 BG1 Task 1 → BG2 Task 6 的跨文件依赖，避免运行时数据竞争
- E2E test plan 覆盖了 spec 全部 6 个 AC 组

**做错了什么**：
- Round 2: timer guard 代码 bug（`isDone` flag 模式而非 `context.state.interval` 模式）——引入了一个无效的 guard
- Round 3: BG1→BG2 集成缺口——BG1 修改了 render 函数签名（加 sessionShortId/elapsed 参数），但没有 task 负责在 index.ts 的 renderResult 中调用这些参数。直到 Round 3 才发现，新增 Task 6 修复
- 13 个 test case 全部标为 `type: "manual"`，没有考虑项目的实际测试能力。这导致 Phase 4 只能通过静态代码分析验证，且 TC-1-03 的实时计时行为无法确认

**如果重来**：
1. Plan 完成后做一个 "数据流自检"：谁提供数据、谁消费、接线是否完整？这个检查会在 Round 1 就发现 BG1→BG2 缺口
2. Test case 设计加入项目测试能力检测：Pi extension 只支持 tsc + eslint + grep，应标记 12/13 为 integration type

### Phase 3 (Dev) — 评分：B

**做了什么**：完成 render.ts 和 index.ts 的全面重构。主功能 commit `d4530d3` + MUST FIX 修复 commit `a5414e8`。tsc 0 error, eslint 0 error。

**做对了什么**：
- head+tail 文件拼接策略绕过了 edit 工具的 Unicode 匹配限制
- capturedSessionId 提升到闭包外层解决了对象字面量内不能声明 let 的问题
- Code review subagent 准确发现了 2 条 MUST FIX（header 三层结构、timer 缺失）

**做错了什么**：
- Subagent abort 浪费 ~10 min：按 plan 走"复杂路径"派遣 subagent，但 BG2 Task 6 被 abort，被迫回退到主 agent 直接编码。2 文件改动用 subagent 纯属 overhead
- Unicode 匹配浪费 ~8 min：反复尝试 edit 的 oldText Unicode 转义写法，应该一开始就用 write
- 编码时没有逐条对照 spec F1-F8 验证——导致 renderSingleCollapsedText 的 header 格式和 renderResult 的 timer 两个 spec 合规问题被 code review 发现而非自检发现
- ToolRenderContext 的 `state`/`invalidate()` 通过双重类型断言绕过编译检查，运行时可能静默失效

**如果重来**：
1. ≤2 文件直接用主 agent 编码，不走 subagent
2. 编码完成后按 spec F1-F8 逐条自检
3. 先读 Pi 源码的 types.ts 确认 context API，再做类型断言

### Phase 4 (Test) — 评分：B

**做了什么**：13/13 test cases PASS。全部通过 subagent 静态代码分析完成。TC-1-03 经历 Round 1 (false) → Round 2 (true)。

**做对了什么**：
- 在无法启动 TUI 的环境下，用代码结构分析覆盖了 12/13 个 case 的功能验证
- grep 全项目搜索有效确认了 collect_subagent 的完全移除（TC-5-01/02/03）
- JSON 格式验证脚本确保了 test_execution.json 的 schema 正确性

**做错了什么**：
- TC-1-03 Round 1 标记 false 是正确的（静态分析无法证明运行时 1s 刷新），但 Round 2 改为 true 的论据（"代码逻辑与 Pi bash tool 的 timer 模式一致"）有风险——`ToolRenderContext` 通过类型断言访问的属性在运行时可能不存在
- 手动用 Python 修改 JSON 时写了 `true` 而非 `True`（低级语法错误）
- 全部 case 为 manual type 是 Phase 2 的设计缺陷，Phase 4 被迫自行发明验证方法

**如果重来**：Phase 2 就把 12/13 case 标为 `integration`，只留 TC-1-03 为 `manual`。Phase 4 可以用自动化脚本执行 integration cases。

### Phase 5 (PR) — 评分：A

**做了什么**：CI 预检 → 创建 feature 分支 → push → gh pr create → 产出 pr_evidence.md + ci_results.md → Gate PASS → subagent 整体复盘。

**做对了什么**：
- CI 预检发现项目没有 CI pipeline，在 ci_results.md 中记录了 `ci_configured: false` 和本地验证结果
- PR body 包含完整的 change summary、test results、spec reference
- 分支命名符合规范（`feat/subagent-tui-rendering`）

**做错了什么**：
- PR body 的 heredoc 语法在 bash 中失败（单引号嵌套问题），需要先写入临时文件再用 `--body-file`。这是一个 shell 语法问题，不是 harness 流程问题
- 整体复盘（overall_retrospect.md）由 subagent 产出，但 YAML frontmatter 又是嵌套格式，需要手动修正。这再次印证了 P0 级格式问题

**如果重来**：无重大改进。Phase 5 流程顺畅。

---

## 2. 跨 Phase 模式识别

### 模式 1: Review subagent YAML frontmatter 格式不匹配 — 贯穿全部 5 Phase

| Phase | 出现次数 | 修正耗时 |
|-------|---------|---------|
| P1 (Spec) | 1 次 | ~5 min |
| P2 (Plan) | 3 次 | ~6 min |
| P3 (Dev) | 1 次 | ~2 min |
| P5 (PR) | 1 次 | ~1 min |
| **合计** | **6 次** | **~14 min** |

每个 phase 的 review subagent 都输出嵌套 YAML（`review: { verdict: ... }`）而非 gate 要求的 flat 格式（`verdict: pass`）。根本原因是 task prompt 中没有显式模板——subagent 自行选择了更"结构化"的嵌套格式。

**修复成本极低**：在 review subagent 的 task prompt 中加一行模板字符串。但这个问题在 5 个 phase 中都没有被根治，说明"低优先级的小问题"容易被持续忽略。

### 模式 2: `context.state` / `context.invalidate()` 运行时风险 — 贯穿 P3→P4→P5

Phase 3 编码时通过 `as unknown as Record<string, unknown>` 双重类型断言访问 `ToolRenderContext` 上未定义的属性。Phase 4 静态分析无法验证运行时可用性。Phase 5 PR merge 前仍未实际验证。

这是一个 **"沉默退化"风险**：如果运行时不存在这些属性，timer 不会启动，不会报错，但实时计时不工作。防御性代码确保了不会 crash，但也意味着问题可能长时间不被发现。

**建议**：PR merge 前在 Pi 中执行一次 medium complexity subagent，观察 elapsed 是否每秒刷新。

### 模式 3: 测试类型设计脱离项目实际 — P2→P4 级联影响

Phase 2 把 13 个 test case 全标为 `manual`，假设需要在 Pi TUI 中交互观察。Phase 4 发现 Pi extension 没有测试框架，只能通过静态代码分析替代。

**根因**：test_cases_template.json 的设计没有考虑项目技术栈的实际测试能力。Pi extension 只支持 tsc + eslint + grep，不支持 Playwright/jest/curl。

**级联路径**：P2 设计失误 → P4 执行困难 → P4 验证可信度降低（TC-1-03 Round 2 的论据有风险）

### 模式 4: Subagent 调度成本在某些场景下超过直接编码

Phase 3 按 plan 设计走"复杂路径"（7 tasks > 4 → subagent-driven dev），但实际改动只涉及 2 个文件。Subagent 的上下文构造、派遣、等待、abort 处理的总开销（~10 min），超过了主 agent 直接编码的预估时间（~20 min without abort）。

**根因**：路径选择基于 task 数量而非文件数量。2 文件的改动无论有多少 tasks，都应由主 agent 直接编码——同文件的函数间共享常量和类型，串行 subagent 无法利用并行优势。

### 模式 5: Phase 2→Phase 3 的集成缺口是 L1 plan 的典型失败模式

BG1 修改了 render 函数签名（加 sessionShortId/elapsed 参数），但没有 task 负责在 index.ts 的 renderResult 中传递这些参数。直到 plan review Round 3 才被发现。

这类"接口变更但调用方未更新"的问题在手动 plan review 中容易被遗漏。如果 plan 的 task list 有 `reads_file`/`writes_file` 字段，gate 可以自动检测跨文件依赖的接线完整性。

---

## 3. Harness 整体体验

### 优点

| 方面 | 评价 |
|------|------|
| **Gate 准确性** | 5 个 phase 的 gate 全部准确：MUST FIX 都是真实缺陷，没有 false positive，错误定位精确到具体行 |
| **Spec/Plan 模板** | YAML frontmatter 格式统一、机器可解析，对多 phase 自动化流转至关重要 |
| **Review 覆盖度** | Spec compliance review + Code review 两层覆盖，发现了 P3 的 2 条 MUST FIX |
| **ADRs 复用** | pi-mono bash.ts 的 timer 模式在 P2/P3 中直接复用 |
| **Subagent 任务拆分** | 复盘 subagent（medium complexity）产出质量稳定 |

### 摩擦点（按严重度排序）

| 摩擦 | 严重度 | 频次 | 累计耗时 |
|------|--------|------|---------|
| Review subagent YAML 格式不匹配 | **高** | 6 次 | ~14 min |
| Subagent abort 无重试 | **中** | 1 次 | ~10 min |
| Manual-only 测试用例 | **中** | 1 次（级联） | Phase 4 执行困难 |
| 跨文件依赖缺口遗漏 | **中** | 1 次 | Plan Round 3 |
| Edit 工具 Unicode 不兼容 | **低** | 1 次 | ~8 min |
| PR body heredoc 语法 | **低** | 1 次 | ~1 min |

### 自动化缺口优先级

| 优先级 | 缺口 | 解决方向 | 预估节省 |
|--------|------|----------|---------|
| **P0** | Review subagent frontmatter 格式 | task prompt 嵌入 flat YAML 模板 | ~14 min/project |
| **P1** | 测试能力检测 | Phase 2 plan skill 加入 `check_test_capabilities()` | 避免 P4 重新发明验证方法 |
| **P2** | 跨文件依赖自动检测 | Plan task 增加 `reads_file`/`writes_file`，gate 检查接线 | 避免 Round 3 才发现缺口 |
| **P3** | CI 配置 | 为 xyz-pi-extensions 配置 GitHub Actions（tsc + eslint） | 防止退化 |
| **P4** | Subagent 路径选择 | 基于"涉及文件数"而非"task 数"选择简单/复杂路径 | 避免 abort 浪费 |

---

## 4. 系统性教训

### 4.1 L1 ≠ 简单

这个项目被评估为 L1（2 文件，TUI 渲染改动），但经历了 3 轮 plan review、1 次 subagent abort、2 个 code review MUST FIX。L1 只表示文件范围和跨模块依赖程度，不代表执行复杂度。TUI 渲染的统一（实时计时器生命周期、跨模式可视化、session ID 传递）有内在复杂度，不应低估。

### 4.2 小问题的复利效应

Review subagent 的 YAML 格式问题是一个"修复成本极低（1 行模板）、但每次都被忽略"的问题。5 个 phase 累计浪费 ~14 min。这类问题不是技术难题，而是优先级判断失误——应该在一次出现后就立即根治，而不是每轮手动修复。

### 4.3 项目测试能力应作为 plan 阶段的显式输入

"Pi extension 没有测试框架"不是新信息——项目 CLAUDE.md 有说明。但 Phase 2 没有 读取这个信息并将其转化为 test case type 决策。Plan skill 应该在"编写测试用例"步骤前加入"检测项目测试能力"子步骤。

### 4.4 静态分析对 TUI 渲染的验证边界

代码静态分析可以验证"函数存在、逻辑正确、参数传递完整"，但无法验证"ANSI escape 序列是否被 pi-tui 正确解析"、"elapsed 是否每秒在终端上刷新"。这个边界在 Phase 4 诚实面对了（TC-1-03 Round 1 标记 false），但 Round 2 的"代码逻辑一致性"论据实际上跨越了这个边界。对于 TUI 渲染功能，运行时验证不可替代。

---

## 5. 推荐行动

| # | 行动 | 优先级 | 影响范围 |
|---|------|--------|---------|
| 1 | Review subagent task prompt 加入显式 flat YAML 模板 | P0 | 所有 future phases |
| 2 | ≤2 文件改动由主 agent 直接编码，不走 subagent | P1 | Dev phase |
| 3 | Phase 2 plan skill 加入项目测试能力检测步骤 | P1 | Plan + Test phases |
| 4 | PR merge 前在 Pi 中运行一次 subagent 验证 timer | P1 | 本 PR |
| 5 | 为 xyz-pi-extensions 配置 GitHub Actions CI（tsc + eslint） | P2 | 所有 future PRs |
| 6 | Plan task 增加 `reads_file`/`writes_file` 字段 | P2 | Plan phase gate |

---

## 6. 最终评分

| Phase | 评分 | 主要失分原因 |
|-------|------|-------------|
| P1 (Spec) | A- | Out of Scope 初始缺失, review 格式 x1 |
| P2 (Plan) | B+ | 3 轮 review, 集成缺口 Round 3, manual-only tests |
| P3 (Dev) | B | Subagent abort, Unicode, 2 条 MUST FIX |
| P4 (Test) | B | Manual-only 用例, TC-1-03 验证争议 |
| P5 (PR) | A | 无 CI pipeline (pre-existing), review 格式 x1 |
| **总体** | **B+** | 主要损失在 review 格式重复修复和 subagent abort |
