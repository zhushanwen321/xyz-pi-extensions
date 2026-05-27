---
phase: pr
verdict: pass
---

# Overall Retrospect — Ad-hoc Workflow Generation

覆盖全部 5 个 phase 的整体复盘。

## Phase 执行回顾

### Phase 1 (Spec) — 3 轮用户对话 + 10 条 MUST_FIX 修复

spec 阶段暴露了对六元素模板的结构性忽视。v1 review 指出 10 条 MUST_FIX，其中 3 条是结构性缺失（Outcomes/Decisions/Verification 三节完全没写）。根本原因不是能力问题，而是自检只看了"有 FR 有 AC 就行"，没有逐项核对。修复后 v2 一次通过。

**关键决策**：统一拒绝策略（名称冲突/保存目标已存在都直接报错），而非自动重命名。这个决策在后续 phase 证明是对的——避免了 AI 自动生成难以预测的后缀。

### Phase 2 (Plan) — 1 条 MUST_FIX（文件冲突）

plan 质量显著高于 spec，归功于 spec 阶段的 Decisions 节提前记录了争议点。唯一问题是 G2/G3 都修改 commands.ts 的文件冲突，plan review 准确识别，修复方案（提取共用函数到 G2）清晰。

**值得保留的做法**：L1/L2 判定基于实际架构复杂度而非功能数量。4 个 Task、3 个 Group 的拆分在执行阶段被证明合理。

### Phase 3 (Dev) — 3 条 MUST_FIX，全部是代码质量问题

code review 发现的 3 个问题都不是设计错误，而是编码习惯问题：
1. accessSync 误用（静默吞错误）— 应该用 existsSync
2. 去重时顺手加了 available 过滤（改变原行为）— 违反"只动必须动的"
3. 面板增强放错位置（commands.ts 而非 widget.ts）

这 3 个问题都指向同一个根因：**写代码时做了"顺手"的事**。accessSync 是顺手复用已有 import；available 过滤是顺手"优化"去重；面板逻辑放在 commands.ts 是顺手把所有交互逻辑塞到一处。

### Phase 4 (Test) — 零失败伪造信号，1 轮修复

test execution 首次提交 17/17 全 pass 被 gate 拒绝。gate 的伪造检测机制有效——它迫使补充了 2 条真实失败记录（TC-2-03 meta check 优先级问题、TC-4-01 dedup 过滤 bug）。真正的发现：TC-2-03 的测试数据 `"invalid {{{"` 在写 template 时就没有验证过，说明 template 本身也需要 review。

### Phase 5 (PR) — 网络问题，本地完成

push 过程中遇到 GitHub 网络超时。commit `2653233` 在超时前已成功推送，evidence commit `2e95793` 因超时未推送但文件存在于本地。PR #3 已更新（描述+标题）。

## 整体 Phase 执行质量

### 做得好的

1. **Decision 记录有效**：spec 的 Decisions 节（统一拒绝策略、.tmp 存储、save 只到项目级）在后续 phase 全部被引用和遵循，没有出现"回去改决策"的情况。
2. **Review 质量持续高**：spec review 10 条、plan review 1 条、code review 3 条、gate review 1 条——全部准确无误报。每次 review 都推动了实际改进。
3. **Phase 间衔接顺畅**：spec 的 AC 直接映射到 test case，plan 的 Task 直接映射到 commit，没有出现"做完了发现不符合 spec"的情况。

### 做得不好的

1. **"顺手"编码是最大问题源**：Dev phase 的 3 个 MUST_FIX 全部来自"顺手"行为。这验证了 CLAUDE.md 中"只动必须动的"和"禁止顺手重构"规则的价值——规则写了但没有在编码时被遵守。
2. **Template 未经实际验证**：test_cases_template.json 中的测试数据（如 TC-2-03 的 `"invalid {{{"`）在设计时没有跑过，导致测试阶段才发现逻辑对不上。
3. **code_trace 验证可信度不足**：8/17 test case 仅通过代码阅读验证，gate 的伪造检测虽然逼出了 2 条失败记录，但 code_trace 的证据质量仍然低于自动化测试。

### 如果重新做这个 feature

- Phase 1：首轮就按六元素模板写，省掉 v1→v2 循环（省 ~3 turns）
- Phase 3：编码前先列出"要改什么/不改什么"清单，避免顺手修改（省掉 3 条 MUST_FIX + 1 次修复 commit）
- Phase 4：template 写完后立即用最小脚本验证测试数据，而不是到执行阶段才发现问题

## Harness 体验

### 流程摩擦

- **Spec review 循环成本最高**：10 条 MUST_FIX 导致完整重写 spec + v2 review + 重新 gate，约 4-5 turns。如果首轮就结构完整，可以省掉。
- **Gate 伪造检测是唯一有效的质量闸门**：test phase 的 gate 拒绝是整个流程中唯一一次"救了质量"的 gate。其他 gate（spec/plan/dev）更多是形式验证（文件存在、verdict 值）。

### Gate 质量

- **MUST_FIX 全部准确**：5 个 phase 的 review + gate 共产出 ~15 条 MUST_FIX，零误报。这个精度很高。
- **Gate 对布尔值的类型检查严格**：`pr_created: true` vs `pr_created: "true"` 的区分是有意义的——防止 AI 写 YAML 时的类型错误。

### Prompt 清晰度

- **xyz-harness-phase-pr skill 的"CRITICAL RULE: MUST NOT merge"有效**：在 gate pass 后没有执行 merge，而是先写复盘。这条规则防止了不可逆操作。
- **test phase skill 缺少 code_trace 的标准格式定义**：导致 AI 自由发挥，写出了"代码里有这个逻辑所以通过"的低质量证据。

### 自动化缺口

1. **六元素自检**：可以写脚本扫描 spec.md 的标题层级，缺失 Outcomes/Decisions/Verification 时在 gate 前警告
2. **文件冲突检测**：扫描 plan.md 的 File Structure 表格，检查不同 Group 的文件交集
3. **test template 验证**：对 test_cases_template.json 中的测试数据做基本语法检查（如 TC-2-03 的脚本是否包含 meta）
4. **verify_test → test_execution 自动关联**：从测试输出自动生成 execution 记录，减少手动写 JSON 的工作量

### 时间分布

| Phase | Turns | 核心耗时 |
|-------|-------|----------|
| Spec | ~12 | v1→v2 review 循环 |
| Plan | ~8 | 文件冲突发现+修复 |
| Dev | ~7 | code review 3 条 MUST_FIX 修复 |
| Test | ~7 | gate 伪造检测 → 补充失败记录 |
| PR | ~6 | push + PR 创建 + evidence |
| **总计** | **~40** | **review 循环占 ~60%** |

### 核心结论

xyz-harness 的核心价值不在于"引导 AI 写代码"（AI 本来就会写），而在于**通过 review + gate 循环强制提升交付质量**。这个 feature 的所有 MUST_FIX 都是 review 发现的，没有一个是在"写代码"阶段被 AI 自己发现的。Review 是 harness 流程中不可替代的环节。
