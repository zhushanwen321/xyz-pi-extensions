---
phase: pr
verdict: pass
---

# Overall Retrospect — pi-session-analyzer Phase 2

覆盖全部 5 个 phase（spec → plan → dev → test → pr）。

---

## 1. Phase Execution Review

### Timeline

| Phase | Turns | Key Event |
|-------|-------|-----------|
| Spec | ~8 | 2 rounds review，补齐采样传递 + 建议规则定义 |
| Plan | ~7 | 2 rounds review，补齐 DORMANT 时间维度 + to_markdown N/A 处理 |
| Dev | ~20 | 4 tasks 完成 + 五步审查（BLR/Standards/Taste/Robustness/Integration），修复 8 条 MUST_FIX |
| Test | ~3 | 12/12 测试首轮全部通过 |
| PR | ~6 | push + PR #7 创建，gate 第 1 轮被拒（bare repo remote ref 未 fetch），修复后通过 |

### 总体判断

Phase 2 从 spec 到 PR merge-ready 共约 44 turns。核心功能（miner + reporter + analyze CLI）在 dev 阶段一次性实现完成，29 个测试通过，全量分析 28 秒。五步审查发现了 8 条有实质价值的 MUST_FIX（类型防护、错误隔离、函数拆分、日志补全），没有出现"审查通过但实际有问题"的漏检。

### 跨 Phase 反复出现的问题

1. **Extractor 返回值类型假设错误**（Dev Phase 发现）。`sessions` 字段是 list 不是 int，`count` 字段可能不存在。这个问题在 Plan 阶段的 Interface Contracts 中用 Python AST 验证了顶层 key，但没验证嵌套值的类型。教训：接口验证要深入到叶子节点，不只是顶层 dict key。

2. **`must_fix` frontmatter 语义不一致**（Plan/Dev Phase 反复出现）。Review subagent 对 `must_fix` 的理解不统一——有的写"总发现数"，有的写"当前开放数"。每次都需要主 agent 手动修正。根因是 task prompt 中没有明确约定语义。

3. **性能瓶颈发现太晚**（Dev Phase 集成测试才发现）。`analyze_user_patterns` 的 O(n*m) SequenceMatcher 在 673 sessions 上需要 363 秒。如果在 spec/plan 阶段评估各 extractor 的计算复杂度，可以更早制定应对策略（重写 vs 限制输入量），而不是在 dev 阶段临时折衷。

### 各 Phase 得失

**Spec（得大于失）**：前置设计文档（docs/self-evolution/04-phased-roadmap.md）大幅减少了 spec 的工作量。两轮审查各发现 1 条实质性问题，ROI 高。

**Plan（得大于失）**：L1 复杂度评估准确，单一 plan.md 足够。Interface Contracts 章节有用但不够深入。两轮审查各发现 1 条有价值的问题。

**Dev（最大风险 phase，最终控制住了）**：4 个 task 按计划完成。五步审查流程偏重但发现了 8 条真实的 MUST_FIX。Integration Review 有 1 条误报（对 seen set 去重语义的误解）。总体来说，审查的 ROI 在这个规模的项目（3 文件 ~800 行）上偏低——同样的问题用 2 步审查（逻辑 + 健壮性）就能覆盖，不需要 5 步。

**Test（最顺畅的 phase）**：12/12 首轮通过，零修复。test_cases_template.json 的预定义起了关键作用——Plan 阶段就定义好了测试步骤，Test 阶段只需执行。

**PR（有小波折）**：bare repo + worktree 结构导致 remote ref 未自动 fetch，gate reviewer 用 `git branch -r --contains` 检查时看不到远程分支，判定为"PR 伪造"。修复后通过。这是 worktree 环境下的已知陷阱。

### What Would You Do Differently

1. **Dev Phase 开始前验证 extractor 返回值的叶子节点类型**。用 `python3 -c` 打印每个 extractor 的实际输出（不只是 AST 分析），5 分钟投入可以避免 1 小时的类型错误调试。
2. **Plan Phase 评估 extractor 计算复杂度**。对每个 extractor 标注时间复杂度（O(n)、O(n*log n)、O(n*m) 等），高风险的提前制定应对方案。
3. **五步审查降为三步**（BLR + Robustness + Integration）。Standards 和 Taste 的发现与 BLR/Robustness 大量重叠，对于 <1000 行新代码的项目不够经济。
4. **Review task prompt 中固定 `must_fix` 语义定义**。在每次 dispatch review subagent 时附加一句："must_fix = 当前未修复的问题数量，已修复的记为 0"。

---

## 2. Harness Usability Review

### Flow Friction

1. **五步审查流程在中小项目上过重**。3 个文件、~800 行新增代码，5 步审查产出了 ~1200 行审查报告。审查报告的总行数超过了被审查代码的行数。建议增加"轻量审查模式"：代码量 < 1000 行时用 3 步（BLR + Robustness + Integration），> 3000 行时用完整 5 步。

2. **Review subagent 之间无信息共享**。Batch 1 的 4 个并行审查（BLR、Standards、Taste、Robustness）各自独立运行，大量重复发现（如"函数超 80 行"在 3 个审查中同时出现）。建议 Batch 1 完成后合并去重，再作为 Batch 2（Integration）的输入。

3. **Gate check 对 bare repo + worktree 环境的兼容性不足**。`git branch -r --contains` 在 worktree 中需要显式 fetch 新分支的 remote ref，否则看不到已推送的分支。这是环境特有的问题，但 gate reviewer 将其判定为"PR 伪造"过于激进。

### Gate Quality

Gate 系统总体可靠：
- **Phase 1-4**：gate check 准确验证了所有 deliverable 的存在性和 frontmatter 正确性。阻止了 must_fix > 0 的情况通过。
- **Phase 5**：gate reviewer 的验证逻辑（检查远程分支可见性 + 证据文件是否在 commit 中）方向正确，但在 worktree 环境下产生了 false positive。建议 gate reviewer 增加备用验证手段（`gh pr view` CLI）来交叉确认。

### Prompt Clarity

各 phase skill 的指导清晰度排序：
1. **Test（最清晰）**：test_execution.json 的字段 schema 表格非常实用，直接避免了格式错误。
2. **Spec/Plan（清晰）**：brainstorming 和 writing-plans skill 的结构化步骤明确。
3. **Dev（尚可）**：五步审查的 instructions 充分，但缺少"何时降级为三步"的指导。
4. **PR（有改进空间）**：CI/防护预检的 bash 脚本模板在 bare repo 环境下不适用（`npm run lint` 找不到 eslint），建议增加环境兼容性检查。

### Automation Gaps

1. **集成测试无自动化 runner**。当前是手动 bash 命令逐条执行 + 手写 JSON。对于 12 条用例可以接受，但 50+ 条时需要自动化。
2. **Review frontmatter 修正未自动化**。主 agent 需要在每次 review 完成后手动修正 `must_fix` 和 `verdict` 字段。应该在 task prompt 中固化语义定义。
3. **Gate check 脚本本地不可用**。skill 文档引用了 `skills/xyz-harness-gate/scripts/check_gate.py`，但文件不存在。Phase 4 的 Self-Check 步骤无法执行。建议要么提供脚本，要么从 skill 中移除该步骤。

### Time Sinks

1. **pytest 等待时间**（~100 秒/次，累计 ~7 分钟）。test_analyze.py 解析真实 JSONL 文件，应该用 mock 数据。
2. **全量分析首次运行 6 分钟**（users extractor O(n*m) 瓶颈发现过程）。
3. **Review frontmatter 手动修正**（每个 phase ~1 turn，累计 4 turns）。
4. **Gate Phase 5 false positive 修复**（2 turns）。

### 总体评分

| 维度 | 评分 | 说明 |
|------|------|------|
| Spec 质量 | 8/10 | 前置设计充分，2 轮审查各捕获 1 条实质问题 |
| Plan 质量 | 7/10 | L1 评估准确，但 extractor 类型验证不够深入 |
| Dev 质量 | 8/10 | 核心功能一次完成，五步审查捕获 8 条真实问题 |
| Test 质量 | 9/10 | 12/12 首轮通过，零返工 |
| PR 质量 | 6/10 | bare repo 兼容性波折，gate false positive |
| Harness 体验 | 7/10 | 流程完整但五步审查对中小项目过重 |

**最终结论**：Phase 2 的功能目标已完全达成（3 个交付物全部完成，673 sessions/28s，12/12 测试通过，PR #7 open）。harness 流程在质量保障上有效，但在流程经济性上有优化空间——主要是审查步骤的分级和 review subagent 的信息去重。
