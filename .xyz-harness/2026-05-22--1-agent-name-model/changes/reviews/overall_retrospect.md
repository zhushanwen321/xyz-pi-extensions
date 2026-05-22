---
phase: pr
verdict: pass
---

# Overall Retrospect — Subagent TUI 渲染统一与优化（5 Phase 覆盖）

## 项目基本信息

| 维度 | 值 |
|------|-----|
| 项目 | xyz-pi-extensions, subagent extension |
| 改动范围 | `subagent/src/render.ts` + `subagent/src/index.ts`（2 个文件） |
| 复杂度评估 | Medium（L1，不跨模块） |
| 总时长 | 5 个 Phase，约 2-3 轮对话 |
| PR | https://github.com/zhushanwen321/xyz-pi-extensions/pull/1 |

## Phase 执行质量总结

### Phase 1 (Spec) — 评分：A-

**效率**：高。单轮 spec 产出通过 completeness check，review 2 轮。
**质量**：完整。8 FR, 6 AC, 30+ checkpoint, 7 constraints, Out of Scope。completeness check 发现了缺失的 Out of Scope 和歧义范围。
**问题**：review 子 agent 的 YAML frontmatter 格式始终不匹配模板；subagent API 429 错误导致一次 review 失败，需要人工补写。
**关键产出**：spec.md → plan.md 的 F/AC → task 映射清晰，减少了 Phase 2 的歧义。

### Phase 2 (Plan) — 评分：B+

**效率**：中等偏低。L1 计划（2 个文件）经历了 3 轮 review，其中 Round 2（timer guard bug）和 Round 3（集成缺口）是真实缺陷。如果没有这两类缺陷，应能在 1 轮完成。
**质量**：高。7 个 task 的 Execution Group 拆分合理，Wave 调度考虑了 BG1 Task 1 与 BG2 Task 6 之间的跨文件依赖。E2E test plan + 13 测试用例覆盖全面。
**问题**：timer guard 代码 bug（isDone → interval 模式）和 BG1→BG2 集成缺口直到 Round 3 才被发现。review frontmatter 格式问题第三次出现。
**改进点**：对跨文件依赖（"谁提供数据、谁消费、接线完整？"）应该有一个明确的自检步骤。

### Phase 3 (Dev) — 评分：B

**效率**：中等偏高。实际编码效率高，但被 subagent abort 和 Unicode 匹配问题拖慢了约 18 分钟。最终由主 agent 直接编码完成。
**质量**：中高。code review 发现 2 条 MUST FIX（header 不符合三层结构，renderResult 缺少 timer），均在第二轮修复。类型检查（tsc）0 error。
**问题**：subagent abort 暴露了并行执行模式的脆弱性——没有自动重试或 fallback 机制。Unicode 转义（\u2717）与 edit 工具不兼容。ToolRenderContext 的类型定义不足，需要双重类型断言。
**改进点**：小文件批量修改用 write 替代 edit；subagent 复杂路径失败时应自动触发回退方案。

### Phase 4 (Test) — 评分：B

**效率**：中等。13 个 manual 测试用例全部通过静态代码分析完成，无需 TUI 交互。TC-1-03 需要 Round 2 修正。
**质量**：中。静态分析可以验证代码结构和逻辑路径，但 timer 的运行时行为（setInterval + context.invalidate() 是否在工作）无法确认。
**问题**：全部测试用例为 manual 类型——这是 Phase 2 设计时的遗漏。Pi extension 没有 TUI 测试框架，无法执行交互式验证。应该设计 `type: "integration"` 的用例，通过 tsc + grep + 代码结构分析来验证。
**改进点**：Phase 2 的 test case 设计应考虑项目的实际测试能力，而非照搬模板。

### Phase 5 (PR) — 评分：A

**效率**：高。PR 创建、push、local checks 一步完成。
**质量**：高。tsc 0 error, eslint 0 error（51 pre-existing warnings），PR link 可用。
**问题**：项目没有配置 CI pipeline。虽然本地验证通过，但没有 CI gate 来防止退化。
**改进点**：建议配置 GitHub Actions CI（tsc + eslint）。

## 跨 Phase 模式识别

### 1. Review 子 agent YAML frontmatter 格式不匹配（P1, P2, P3）

每个 Phase 的 review subagent 都输出嵌套 YAML（`review: { verdict: ... }`）而非要求的平坦格式（`verdict: pass`）。每次都需要主 agent 手动修正后再提交 gate。

**根源**：task prompt 中缺少显式的 YAML 模板。subagent 依赖隐式格式说明。
**影响**：P1 (5min) + P2 (6min) + P3 (3min) = 约 14 分钟机械劳动。
**修复方案**：在 review subagent 的 task prompt 中加入 `输出 frontmatter 必须使用平坦格式：\n---\nverdict: pass\nmust_fix: 0\n---`。

### 2. Subagent abort 无重试机制（P3）

Wave 1 尝试 subagent 并行执行 BG1/BG2 但 BG2 Task 6 被 abort。没有自动重试逻辑，退回到主 agent 直接编码。

**根源**：subagent 的并行执行层没有统一的 retry 或 fallback 逻辑。被 abort 后，主 agent 只能重建上下文手动完成。
**影响**：~10 分钟损失。
**修复方案**：不应使用 subagent 来处理同一扩展中 2 个文件的改动——subagent 的上下文传递开销 > 直接编码成本。

### 3. context.state / context.invalidate() 运行时风险（P3, P4, P5）

这是三个 Phase 持续记录的未验证风险：ToolRenderContext 是否在运行时暴露 `state` 和 `invalidate()`？当前通过 `as unknown as Record<string, unknown>` 双重类型断言绕过编译检查，但运行时调用可能静默失败。

**根源**：Pi Extension API 的类型定义（`ToolRenderContext`）未包含这些方法，但运行时可能存在。没有方式在不实际运行 Pi 的情况下确认。
**影响**：如果在运行时不可用，timer（F2）将不工作，但不抛出错误。这是一个"沉默退化"风险。
**建议**：PR merge 前在 Pi 环境中实际运行一次 subagent，验证 timer 刷新是否工作。

### 4. 测试类型设计脱离项目实际（P2 → P4）

Phase 2 设计的 13 个测试用例全部为 `type: "manual"`，假设需要在 Pi TUI 中交互观察。但 Pi extension 没有测试框架，Phase 4 发现无法交互式验证。

**根源**：Phase 2 的 test case 模板没有区分"项目支持什么类型的测试"。Pi extension 只支持类型检查（tsc）+ lint（eslint）+ 代码结构分析。
**修复方案**：在 Phase 2 plan skill 中加入测试能力检测步骤："检查项目技术栈，确认支持的测试类型（unit/integration/manual）"。

### 5. Gate 自动产生过期 review 文件（P2）

Gate 发现问题时自动创建新的 review 文件（`plan_review_v{N}.md`），反映旧状态。修复 plan 后，这个 review 文件的 frontmatter（verdict/must_fix）必须手动更新才能通过 gate。

**根源**：Gate 不做自动重验证——它在当前文件系统状态上做检查。
**影响**：每次修复后需要额外一步手动操作。
**改进方向**：Gate 应该在修复后自动重新验证计划文件，而不是依赖手动维护的 review meta file。

## Harness 整体体验评估

### 优点

| 方面 | 评价 |
|------|------|
| **Gate 质量** | 准确。所有 P1-P5 的 MUST FIX 都是真实缺陷，没有 false positive。错误定位精确到具体行和字段。 |
| **Template 一致性** | spec/plan/test case 的 YAML frontmatter 格式统一、机器可解析。这对多 Phase 自动化流转至关重要。 |
| **Execution Group 模式** | BG1/BG2/BG3 的拆分有效隔离了并行依赖。Wave 调度考虑了跨文件依赖（BG1 Task 1 → BG2 Task 6），避免了数据竞争。 |
| **ADRs 复用** | 之前 ADR 中记录的 timer 模式（从 pi-mono bash.ts 发现）在 P2/P3 中直接复用，避免了重新探索。 |
| **Review 覆盖度** | Spec compliance review + Code review 两层覆盖，发现的问题都是真实的。 |

### 摩擦点

| 摩擦 | 影响 | 严重度 |
|------|------|--------|
| Review subagent YAML 格式不匹配（全部 Phase） | ~14min 手动修正 | **高** — 每个 Phase 出现，总计明显 |
| Subagent abort 无重试（P3） | ~10min 上下文重建 | **中** — 仅在复杂路径触发 |
| Manual-only 测试用例（P2→P4） | 无法交互验证 | **中** — 可通过静态分析补偿 |
| Gate 自动文件过期（P2） | 额外手动步骤 | **低** — 每次~2min |
| 跨文件依赖缺口遗漏（P2 Round 3） | 第 3 轮才被发现 | **中** — L1 计划不应该 REV3 |
| edit 工具 Unicode 不兼容（P3） | ~8min 改用 write | **低** — 仅含 Unicode 字符时 |

### 自动化缺口优先级排序

| 优先级 | 缺口 | 解决方向 |
|--------|------|----------|
| P0 | Review subagent frontmatter 格式强制 | task prompt 中嵌入平坦 YAML 模板 |
| P1 | 跨文件依赖自动检测 | plan.md 的 task list 中增加 "reads_file"/"writes_file" 字段，gate 检查接线完整性 |
| P2 | Gate 文件自动刷新 | Gate 验证后自动写入 review 文件 frontmatter |
| P3 | 测试能力检测 | Phase 2 plan skill 加入 `check_test_capabilities()` |
| P4 | Unicode 处理 | edit 工具或 whitespace-fixer 增加unicode-aware 匹配 |

## 系统性教训

### 1. L1 ≠ 简单

这个项目被评估为 L1（2 个文件，TUI 渲染改动），但仍然经历了 3 轮 plan review、1 次 subagent abort、2 个 code review MUST FIX。教训：L1 只指示文件范围和跨模块依赖，不代表执行难度。TUI 渲染的统一（尤其是实时计时器生命周期和跨模式可视化）有内在复杂度。

### 2. Subagent 调度成本在某些情况下超过直接编码

对于 2 个文件的改动，subagent 上下文的构造、派遣、等待、结果收集、abort 处理的总开销，超过了主 agent 直接编码所需的轮次。建议：当改动文件 ≤ 2，且主 agent 已经熟悉该模块时，直接编码比派遣 subagent 更高效。

### 3. 项目级测试能力应作为 plan 阶段的输入

Pi extension 缺少测试框架不是一个新信息——项目 CLAUDE.md 已经有说明。"测试类型脱离项目实际"这个错误的根源是 Phase 2 没有将"当前项目支持什么类型的测试"作为 plan 输入。建议在 plan skill 中加入项目测试能力检测步骤。

### 4. 持续存在的格式问题

Review subagent 的 YAML frontmatter 格式是一个已经持续 3 个 Phase（P1, P2, P3）的问题，每次都是手动修复但没有从根本上解决。这违反了 CLAUDE.md 的"移除 friction"原则。解决方案很简单（加模板到 prompt），不需要架构变更——说明这类小问题的优先级容易被忽略。

## 最终评分

| Phase | 执行质量 | 主要失分原因 |
|-------|---------|-------------|
| Phase 1 (Spec) | A- | Out of Scope 初始缺失, review 格式问题 |
| Phase 2 (Plan) | B+ | 3 轮 review, 集成缺口遗漏 |
| Phase 3 (Dev) | B | Subagent abort, Unicode 问题, 2 条 MUST FIX |
| Phase 4 (Test) | B | Manual-only 用例, 运行时验证缺口 |
| Phase 5 (PR) | A | 无 CI pipeline (pre-existing) |
| **总体** | **B+** | 主要损失在 subagent abort 和 review 格式 |

## Recommendations for Next Project

1. **Review subagent prompt 加入显式 YAML 模板** — 消除全部 Phase 中的 frontmatter 格式修复步骤。
2. **≤2 文件的改动由主 agent 直接编码** — subagent 的开销超过收益。
3. **Phase 2 增加测试能力检测** — 匹配项目的实际测试手段。
4. **在 PR merge 前运行一次 Pi 验证 timer** — 消除 P3-P5 持续记录的运行时风险。
5. **为 xyz-pi-extensions 配置 GitHub Actions CI** — 防止退化，减少对本地手动验证的依赖。
6. **Plan Task 增加 `reads_file`/`writes_file` 字段** — 实现跨文件依赖的自动化验证。
