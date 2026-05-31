---
phase: pr
verdict: pass
---

# Overall Retrospect — context-engineering Plugin

覆盖全部 5 个 phase 的整体复盘。

## 1. Phase Execution Review

### Summary

从调研到 PR，完成了 context-engineering 插件的全生命周期开发：

| Phase | 产出 | 轮次 | MUST_FIX |
|-------|------|------|----------|
| 1. Spec | spec.md (9 FR, 10 AC) | 2 轮审查 | 5 |
| 2. Plan | plan.md + 5 辅助文档 | 2 轮审查 | 3 |
| 3. Dev | 8 文件 ~1300 行 + 7 单元测试 | 5 步审查，2 轮重审 | 4 |
| 4. Test | 16 集成测试 (23/23 PASS) | 4 个 round 1 失败 | 0 (测试代码 bug) |
| 5. PR | PR #16, 推送合并就绪 | 1 轮 gate | 0 |

**核心成就**：替代了有设计缺陷的 `infinite-context` 插件，用 3 级渐进式压缩管道（L0/L1/L2）实现了与 Pi 原生 compact 共存而非冲突的上下文管理方案。

### Cross-Phase Problems

回顾 5 个 phase，识别出跨阶段的系统性问题：

#### 1. API 假设链：Spec → Plan → Dev 的级联错误

- **Phase 1**：假设 Pi Extension API 有 LLM 调用能力 → spec 审查发现错误 → 重写 FR-4
- **Phase 2**：假设 settings 用 `.jsonl` 格式 → plan 审查发现错误 → 修正为 `.json`
- **Phase 3**：假设 BashExecutionMessage 展开运算符安全 → robustness review 标记为风险

**根因**：没有在项目启动时建立一份"Pi API 能力清单"文档。每个 phase 都在独立验证 API 细节，重复阅读相同源码文件。

**改进建议**：在 spec 阶段开始前，dispatch 一个 subagent 专门产出 `api-reference.md`，列出所有需要用到的 Pi 类型、事件、方法签名、配置路径。后续 phase 直接引用，不再重复验证。

#### 2. 测试代码质量 = 实现代码质量

- Phase 4 的 4 个 round 1 失败全部是测试代码 bug（参数顺序、turn boundary 理解、数据量不足、命令语法）
- Phase 3 的 7 个单元测试未能发现 L0 enabled 检查缺失（测试中 L0 总是启用的）

**根因**：测试编写时"凭直觉"而非"查 API"。TC-5-01 凭记忆写参数顺序、TC-10-01 凭猜测写命令语法。

**改进建议**：测试编写规则——每个测试 helper 函数的参数必须从源码 grep 确认，不允许凭记忆。

#### 3. 闭包捕获是最隐蔽的 bug 类别

- Phase 3 Integration Review 发现的闭包捕获错误（`registerCommands(pi, config, stats)` 中 config/stats 是外层 let 变量的快照）
- 这个 bug 只在"新 session 使用旧 store"时才暴露，常规测试几乎无法发现

**改进建议**：Extension 开发的标准模式应该是 `const state = { config, store, stats }` 对象引用模式，而非直接捕获 let 变量。应写入项目 CLAUDE.md。

### What Would You Do Differently (Overall)

1. **调研和 spec 应该在不同会话中完成**：本次在一个会话中完成了调研（3 份报告 2313 行）+ spec + plan，上下文极度膨胀。调研报告只有 ~20% 的内容被 spec 直接引用。应该在调研会话中产出 `api-reference.md` 和 `design-decisions.md`，然后在新会话中只加载这两个精炼文档。

2. **5 步审查对 L1 项目过重**：BLR + Standards + Taste + Robustness + Integration，5 步审查占总开发时间的 ~55%。Phase 3 识别的改进方案（合并为 3 步）仍然有效。建议 L1 项目用 BLR+Standards → Taste+Robustness → Integration 的 3 步流程。

3. **test_execution.json 应自动生成**：Phase 4 花了 30% 的时间手动编写这个文件。可以写一个 vitest reporter 自动生成符合 schema 的 JSON，彻底消除这个摩擦。

4. **Plan 阶段的 Interface Contract 应该更薄**：对于 7 文件的扩展，方法签名表的边际价值低于 Task 描述。L1 项目应该允许省略 Interface Contract，直接在 Task 步骤中写签名。

### Key Risks (Post-Merge)

1. **ImageContent 丢失**：当前压缩只处理 TextContent。如果 tool_result 包含图片（如截图），压缩后图片丢失，recall 也只能恢复文字。这是 spec 的有意识取舍，但用户可能不理解为什么图片消失了。

2. **L1 正则的覆盖率**：正则提取 import/function/class 行只覆盖 TypeScript/Python/Java/C 等主流语言。Rust（`fn`/`impl`/`use`）、Go（`func`/`import`）、Shell 脚本等语言的命中率低。需要基于实际使用数据迭代正则集。

3. **长 session 性能**：recall store 无 GC，Map 在长 session 中持续增长。Phase 3 标记为 LOW，但如果插件在生产中使用 8 小时的 session，可能需要加入 LRU 淘汰。

4. **L2 触发频率**：依赖于 Pi 核心 `getContextUsage()` 返回的 percent 值。如果 provider 不返回 token usage，fallback 估算（chars/4/contextWindow）的精度有限。

## 2. Harness Usability Review

### Flow Friction

| 阶段 | 摩擦点 | 严重度 |
|------|--------|--------|
| Phase 1 | brainstorming skill 的渐进提问流程对"已有充分上下文"的场景过重 | LOW |
| Phase 2 | use-cases.md 和 non-functional-design.md 对 L1 项目是 60% 的内容复述 | MEDIUM |
| Phase 3 | 5 步审查重叠度高（BLR↔Standards ~40%, Taste↔Standards ~30%） | HIGH |
| Phase 4 | test_execution.json 手动编写占 30% 时间 | HIGH |
| Phase 5 | 无 CI pipeline 导致需要手动验证并撰写 ci_results.md | LOW |

**总评**：Phase 3 和 Phase 4 的摩擦最显著。Phase 3 的审查流程对 L1 项目过重；Phase 4 的 test_execution.json 是纯机械工作。

### Gate Quality

- **5 次 gate 全部通过，无 false positive**
- Phase 1 gate：审查发现 5 个 MUST_FIX，全部是 API 兼容性问题（价值最高）
- Phase 3 gate：5 步审查发现 4 个 MUST_FIX，Integration Review 的闭包捕获 bug 是最有价值的发现
- Phase 4 gate：test_execution.json cross-reference 精确匹配 16/16 TC
- Phase 5 gate：pr_evidence + ci_results 格式验证准确

**无 false negative**：没有"gate 通过但实际有问题"的情况。

### Prompt Clarity

- **Phase 1-4 的 skill 描述质量递增**：Phase 1 的 brainstorming skill 最冗长（渐进提问流程），Phase 4 的 test skill 最精确（字段 Schema 表格 + 完整示例 + 常见错误列）
- **subagent task prompt 模板一致性好**：所有 phase 都使用了"指定文件路径 + 检查维度 + 输出路径"的模板
- **test_execution.json 的 Schema 描述是最佳实践**：表格形式的字段说明 + 完整示例 + 常见错误列。这个格式应该推广到所有 evidence 文件的描述中

### Automation Gaps

| 缺口 | 影响 | 实现难度 | 优先级 |
|------|------|---------|--------|
| test_execution.json 自动生成 | Phase 4 30% 时间 | 中（vitest reporter 插件） | P1 |
| 5 步审查合并为 3 步 | Phase 3 55% 时间 | 低（修改 skill 配置） | P1 |
| FR→TC 覆盖矩阵自动检查 | Phase 4 手动验证 | 低（Python 脚本） | P2 |
| 跨章节一致性检查 | Phase 2 plan 内部矛盾 | 中（AST diff） | P2 |
| Pi API 能力清单模板 | Phase 1 API 假设错误 | 低（一次性模板） | P3 |
| 闭包捕获 lint 规则 | Phase 3 最隐蔽 bug | 高（自定义 ESLint 规则） | P3 |

### Time Distribution (Estimated)

| Phase | 占比 | 最大消耗 |
|-------|------|---------|
| Phase 1 (Spec) | 25% | 调研 subagent（~60%），spec 编写（~20%），审查修复（~20%） |
| Phase 2 (Plan) | 15% | Pi 源码阅读（~40%），plan 编写（~35%），审查修复（~25%） |
| Phase 3 (Dev) | 35% | 编码 subagent（~30%），审查+修复+重审（~55%），MUST_FIX 修复（~15%） |
| Phase 4 (Test) | 15% | 集成测试编写（~50%），test_execution.json（~30%），失败修复（~20%） |
| Phase 5 (PR) | 10% | PR 创建+evidence（~60%），复盘（~40%） |

**Phase 3 占比最高**，主要因为 5 步审查 + 2 轮重审的循环。如果合并为 3 步审查，Phase 3 占比可降至 ~25%。

### Top 3 Recommendations for Harness Improvement

1. **审查步骤数应按复杂度分级**：L0 项目 1 步（BLR），L1 项目 3 步（BLR+Standards, Taste+Robustness, Integration），L2 项目 5 步（当前默认）。这能减少 L0/L1 项目 40-55% 的审查时间。

2. **test_execution.json 应由测试框架自动生成**：写一个 vitest reporter 插件，在每个 describe/it 完成时自动记录 caseId、round、passed、execute_steps（从 it() 描述中提取）。这能消除 Phase 4 最大的时间消耗。

3. **在 spec 阶段产出 `api-reference.md`**：强制要求 spec 阶段产出一个精炼的 API 参考文档（类型、事件、方法签名、配置路径），后续 phase 直接引用。这能避免 Phase 1→2→3 的 API 假设级联错误和重复源码阅读。
