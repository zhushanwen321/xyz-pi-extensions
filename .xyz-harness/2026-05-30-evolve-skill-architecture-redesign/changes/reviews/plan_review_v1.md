---
review:
  type: plan_review
  round: 1
  timestamp: "2026-05-31T15:30:00"
  target: ".xyz-harness/2026-05-30-evolve-skill-architecture-redesign/plan.md"
  verdict: fail
  summary: "计划评审完成，第1轮，2条MUST FIX（evolve-daily 输出目录错误 + AC覆盖矩阵缺失apply失败分支验证），需修改后重审"

statistics:
  total_issues: 6
  must_fix: 2
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "plan.md Task 1 Step 3 (evolve-daily/src/index.ts)"
    title: "evolve-daily 输出路径与数据目录结构不匹配"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 2
    severity: MUST_FIX
    location: "plan.md Spec Coverage Matrix + e2e-test-plan.md TS-3"
    title: "AC 覆盖矩阵缺少 apply 失败分支（edit 失败/备份失败）的验证行"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 3
    severity: LOW
    location: "plan.md Task 3 (evolve-apply SKILL.md) ROLLBACK Mode Step 6"
    title: "rollback history.jsonl 记录中有 JSON 语法错误（双引号错位）"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 4
    severity: LOW
    location: "plan.md Task 1 Step 3 (evolve-daily/src/index.ts)"
    title: "daily-reports/ 目录可能不存在，缺少 mkdirSync 预创建"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 5
    severity: LOW
    location: "plan.md Task 2 Step 1 (evolve SKILL.md)"
    title: "SKILL.md 中 UUID 生成指令对 LLM 不够实用"
    status: open
    raised_in_round: 1
    resolved_in_round: null
  - id: 6
    severity: INFO
    location: "spec.md FR-2.2 / plan.md Task 2"
    title: "数据源路径 `daily/*.json` 的来源不明确"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 计划评审 v1

## 评审记录
- 评审时间：2026-05-31 15:30
- 评审类型：计划评审
- 评审对象：`.xyz-harness/2026-05-30-evolve-skill-architecture-redesign/plan.md`

## 评审方法

按 xyz-harness-expert-reviewer SKILL.md「模式一：计划评审」的检查维度逐项审查。已独立读取 spec.md、plan.md、e2e-test-plan.md、use-cases.md、non-functional-design.md，并交叉验证了现有代码（evolution-engine/src/、hooks/src/、pi-session-analyzer/analyze.py）。

---

## 1. spec 完整性

### 目标明确性 ✅

目标清晰：将 ~1500 行 TS extension 替换为 3 个 Skill + 1 个 ~40 行 hook extension。一段话说得清楚。

### 范围合理性 ✅

边界明确：不修改 usage-tracker、Python analyzer、数据目录结构。只做"删除旧的、创建新的"。

### 验收标准可量化 ✅

AC-1 到 AC-5 均可验证（文件存在性、JSON 格式、命令行为），无模糊描述。

### [待决议] 项 ✅

无 `[待决议]` 标记。

### 结论

**spec 完整性通过。**

---

## 2. plan 可行性

### Task 拆分合理性 ✅

5 个 Task，每个粒度适中：
- Task 1: ~40 行 TS 代码（独立可完成）
- Task 2-4: 各 1 个 Markdown 文件（独立可完成）
- Task 5: 文件系统操作（独立可完成）

### 依赖关系 ✅

BG3（清理+安装）正确依赖 BG1 + BG2。BG1 和 BG2 可并行，逻辑正确。

### 工作量估算 ✅

对 L1 项目而言，估算合理。3 个 SKILL.md + 1 个 ~40 行 extension + 删除操作。

### 遗漏检查

对照 spec 逐条：
- FR-1 → Task 1 ✅
- FR-2 → Task 2 ✅
- FR-3 → Task 3 ✅
- FR-4 → Task 4 ✅
- FR-5 → Task 5 ✅
- FR-6 → Task 1-5 分散覆盖 ✅

### 结论

**plan 可行性基本通过**，但有一条实现层面的错误（见 Issue #1）。

---

## 3. spec 与 plan 一致性

### 需求覆盖

| Spec 需求 | Plan 覆盖 | 状态 |
|-----------|----------|------|
| FR-1 每日自动收集 | Task 1 | ✅ |
| FR-2 /evolve 分析 | Task 2 | ✅ |
| FR-3 /evolve-apply 操作 | Task 3 | ✅ |
| FR-4 /evolve-report 展示 | Task 4 | ✅ |
| FR-5 删除旧 extension | Task 5 | ✅ |
| FR-6 创建新文件+安装 | Task 1-5 + symlinks | ✅ |
| AC-1 每日自动收集 | Task 1 | ✅ |
| AC-2 /evolve 分析 | Task 2 | ✅ |
| AC-3 apply/skip/rollback | Task 3 | ✅ |
| AC-4 /evolve-report | Task 4 | ✅ |
| AC-5 清理 | Task 5 | ✅ |

### 额外工作

无 spec 未提及的额外工作。

### 验收标准映射

spec 的 5 个 AC 都在 Spec Coverage Matrix 中有对应行（见 Issue #2 关于覆盖矩阵完整性的补充说明）。

### 结论

**spec 与 plan 一致性通过。**

---

## 4. Execution Groups 合理性

### 分组合理性 ✅

- BG1: 1 Task, 3 文件 ✅
- BG2: 3 Tasks, 3 文件 ✅
- BG3: 1 Task, ~5 文件操作 ✅

### 类型划分 ✅

全后端任务，无前后端混合问题。

### 功能关联度 ✅

- BG2 中 3 个 skill 共享 pending.json 数据模型，关联度高 ✅
- BG1 独立 hook ✅
- BG3 清理+安装，自然收尾 ✅

### 依赖关系 ✅

```
BG1 ──┬──→ BG3
BG2 ──┘
```

正确。BG3 需要 BG1（extension 代码存在）+ BG2（skill 文件存在）才能做 symlink。

### Wave 编排 ✅

Wave 1: BG1 + BG2 并行，无文件冲突、无数据竞争。正确。

### Subagent 配置 ✅

每个 BG 都有 Agent、Model、注入上下文、读取文件、修改/创建文件。完整。

### 上下文充分性 ✅

BG1 引用了 hooks/src/index.ts 和 usage-tracker/src/index.ts 作为参考。BG2 引用了 spec FR-2/3/4 和数据格式。BG3 引用了 symlink 规范。充分。

### 结论

**Execution Groups 合理性通过。**

---

## 5. 接口契约审查

### AC 覆盖矩阵完整性

plan.md 的 Spec Coverage Matrix 覆盖了 AC-1 到 AC-5 的主要成功路径。但 spec FR-3.3 中明确定义了 apply 的失败处理分支：

> "文件修改失败时（edit 报错、输出为空等），LLM 向用户说明原因，保持 pending 状态，不做任何写入"

这个失败分支在矩阵中没有对应的验证行。e2e-test-plan.md TS-3 也缺少 apply 失败场景的测试用例（只有 Apply 成功 + Skip + Rollback）。

这属于 AC 覆盖矩阵的遗漏 → Issue #2。

### 类型传递一致性

pending.json 和 history.jsonl 的数据模型在 spec 和 plan 中一致。

---

## 6. 后端设计充分性

（本项目无传统后端，但 evolve-daily extension 有代码实现，审查其设计。）

### evolve-daily hook 设计审查

plan.md Task 1 给出了完整的代码实现，设计清晰。但有一个**路径错误**：

**问题（Issue #1）**：plan 中 `REPORTS_DIR` 定义为 `~/.pi/agent/evolution-data/daily-reports`，`--output` 参数也写入这个目录。但 Python analyzer 的 `config.py` 中 `REPORTS_DIR` 指向的是 `~/.pi/agent/evolution-data/reports`（不是 `daily-reports`）。`daily-reports/` 目录实际是旧 evolution-engine 自己创建和管理的——它存放的是旧 extension 自己生成的 Markdown 格式报告（`YYYY-MM-DD.md`），不是 Python analyzer 的 JSON 输出。

实际上 `daily-reports/` 目录下目前存在的文件包括：
- `2026-05-29.md`（Markdown，旧 extension 生成）
- `2026-05-30.md`（Markdown，旧 extension 生成）
- `phase2-*.json`、`retrospective-*.json`、`retrospective-*.md`（旧 extension 的其他产物）

Python analyzer 的 `--output` 参数支持直接写入指定路径（已验证 `_write_output` 函数），所以 plan 中用 `--output reportPath` 的方式是可行的。但写入目标应该是新建的 JSON 文件路径，需要确保**语义上不与旧 extension 的 Markdown 报告混淆**。

建议修复方案：
1. 明确 evolve-daily 的输出目录。可以在 `daily-reports/` 下放 JSON 文件（因为旧 extension 要被删除，目录可以复用），但文件名应区分（旧的是 `.md`，新的是 `.json`，天然不冲突）
2. 或者新建一个子目录如 `daily-reports/analyzer/`
3. 在 SKILL.md 中也明确说明 `daily-reports/*.json` 是 Python analyzer 的输出，`daily-reports/*.md` 是旧 extension 的遗留（删除旧 extension 后可忽略）

### 结论

后端设计有实现细节错误，需修正。

---

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | plan.md Task 1 Step 3 | **evolve-daily 输出路径与数据目录语义不匹配**。plan 将 Python analyzer 的 JSON 输出写入 `daily-reports/YYYY-MM-DD.json`，但 `daily-reports/` 是旧 evolution-engine 的 Markdown 报告目录。Python analyzer 自己的 REPORTS_DIR 指向 `reports/` 而非 `daily-reports/`。删除旧 extension 后 `daily-reports/` 中会残留旧 `.md` 文件与新 `.json` 文件混合，语义不清。 | 二选一：(A) 复用 `daily-reports/` 但在 spec 和 SKILL.md 中明确说明 `.json` 是 analyzer 输出、`.md` 是旧遗留可忽略；(B) 改用 `reports/YYYY-MM-DD.json`（与 Python analyzer config 一致）。推荐 (A) 因为旧 extension 会删除，`.json` vs `.md` 天然不冲突。 |
| 2 | MUST FIX | plan.md Spec Coverage Matrix + e2e-test-plan.md TS-3 | **AC 覆盖矩阵缺少 apply 失败分支**。spec FR-3.3 明确定义了 apply 失败处理（"文件修改失败时保持 pending 状态，不做任何写入"），但矩阵和 e2e-test-plan 都没有覆盖这个失败场景。如果 apply 的失败处理不验证，可能导致失败时 pending.json 被错误修改为 applied。 | 在 Spec Coverage Matrix 增加 apply 失货行：`AC-3 apply 失败 → edit 报错时 pending.json 不变 → Task 3`。在 e2e-test-plan TS-3 增加异常测试：构造一个 targetPath 指向不存在文件的 pending 建议并 apply，验证 pending.json 不变且提示用户失败原因。 |
| 3 | LOW | plan.md Task 3 Step 1 ROLLBACK Mode Step 6 | **history.jsonl 记录 JSON 语法错误**。模板中 `""title"` 多了一个双引号：`{"timestamp":"...","instruction":"",""title":"..."}`，应为 `"title"`。 | 修正模板：`"instruction":"","title":"<title>"` |
| 4 | LOW | plan.md Task 1 Step 3 | **daily-reports/ 目录可能不存在**。旧 extension 被删除后首次运行时，如果 `daily-reports/` 目录从未被创建，`existsSync(reportPath)` 会返回 false（正确），但 Python analyzer 的 `--output` 参数有 `parent.mkdir(parents=True)` 会自动创建父目录，所以实际上不会报错。但为健壮性考虑，可以在 extension 中也加 `mkdirSync(REPORTS_DIR, { recursive: true })`。 | 可选修复：在 `evolveDailyExtension` 开头加 `if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true })`。Python analyzer 已有 `parent.mkdir(parents=True)`，不修也可。 |
| 5 | LOW | plan.md Task 2 Step 1 | **UUID 生成指令对 LLM 不够实用**。SKILL.md 中要求 "use `crypto.randomUUID()` style: hex 8-4-4-4-12"，但 LLM 在 Skill 模式下无法调用 crypto API。它只能用 bash 或自行生成。 | 改为 "Generate a random UUID-like string (hex 8-4-4-4-12 format). Use any method: bash `uuidgen`, python `uuid.uuid4()`, or construct manually." |
| 6 | INFO | spec.md FR-2.2 | **`daily/*.json` 数据源来源不明确**。Python analyzer 的 `DAILY_DIR` 指向 `evolution-data/daily`，但 analyzer 的 `--output` 参数在 plan 中写入的是 `daily-reports/`。`daily/` 目录的实际写入者是谁？检查发现可能是 usage-tracker extension 的汇总输出。这不是 plan 的错误，但 spec 中应注明 `daily/*.json` 由 usage-tracker 维护，与 evolve 无关。 | 在 spec FR-2.2 注明：`daily/*.json` 由 usage-tracker extension 生成，非本需求范围。 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

#### 等级判定校准说明

- Issue #1 标 MUST_FIX：数据输出到语义错误的目录，会导致 `/evolve` 和 `/evolve-report` 读到错误的数据文件。虽然 JSON vs MD 不冲突，但 spec 和 plan 中所有数据路径描述建立在一个错误的假设上（`daily-reports/` = Python analyzer 输出），如果不修正，后续所有 SKILL.md 的路径指令都会建立在这个错误假设上。
- Issue #2 标 MUST_FIX：spec 明确定义了失败处理行为（FR-3.3），但 AC 覆盖矩阵和测试计划都未覆盖。如果失败处理不验证，可能出现"edit 失败但 pending.json 被标为 applied"的数据语义错误——符合等级判定校准规则第 4 条"数据语义错误"。

---

## 非功能性设计审查

non-functional-design.md 覆盖了稳定性、数据一致性、性能、业务安全、数据安全五个维度。分析合理：

1. **稳定性**：准确识别了 skill 加载失败不影响 Pi 启动。pending.json 损坏的缓解方式（SKILL.md 中包含格式校验步骤）合理。
2. **数据一致性**：单用户单 session 的无并发假设正确。apply 操作的原子性讨论充分。
3. **性能**：无性能瓶颈，分析正确。
4. **业务安全**：去白名单换 LLM 判断的权衡说明清楚。
5. **数据安全**：backups 机制和路径限制合理。

---

## 结论

**需修改后重审。**

2 条 MUST FIX：
1. evolve-daily 的输出目录路径需明确（与旧 extension 的 `daily-reports/` 目录和 Python analyzer 的 `reports/` 目录对齐）
2. AC 覆盖矩阵和 e2e-test-plan 需补充 apply 失败分支的验证

### Summary

计划评审完成，第1轮，2条MUST FIX，需修改后重审。plan 整体架构和 task 拆分合理，主要问题集中在数据路径语义和测试覆盖遗漏。
