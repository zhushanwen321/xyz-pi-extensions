# 交付物模板：execution-plan.md + execution-plan.html

> 单 Wave 模板见 `wave-template.md`。垂直切片机制见 `vertical-slice.md`。

## frontmatter

```yaml
---
verdict: pass
upstream: code-architecture.md
downstream: coding
---
```

## 章节结构

```markdown
# 执行计划 — {主题}

## Wave 编排总览

### 依赖 DAG 图
（Mermaid graph — Wave 节点 + blocked_by 边）

### 调度表
| Wave | 切片 | P级 | Blocked by | 并行组 | 说明 |
|------|------|-----|-----------|--------|------|

### 并行约束
- 同组最多 3 个 subagent 并行
- 同文件不允许多 Wave 同时修改
- 前端 Wave 需对应后端 API 就绪

## Wave 详情

### Wave 0: {prefactor 或首个切片}
（按 wave-template.md 单 Wave 模板）

### Wave 1: {垂直切片}
...

## 后续迭代（P3 延后项）
- Issue #{N} [P3]: {延后项} — 延后理由

## 测试验收清单（Test Acceptance Manifest）— [MANDATORY]

> **这是实现阶段的 Definition of Done（完成定义）。** 把⑤test-matrix 全量用例（来源 A 功能 + 来源 B NFR）
> 按归属 Wave 列全，作为实现期的唯一验收真相源。设计阶段建得再全，实现端无人核对 = 白建。
> 本清单让"设计闭环"延伸为"实现闭环"：末尾验收 Wave 不绿 = 实现未完成。

| 用例 ID | 归属 UC | 来源 | 断言摘要 | **功能归属 Wave** | **测试执行层** | 状态 |
|---------|--------|------|---------|-----------------|--------------|------|
| T1.1 | UC-1 | A 功能 | 主流程返回正确结果 | Wave 1 | unit | 待验 |
| T1.3 | UC-1 | A 功能 | 唯一约束冲突返回 409 | Wave 1 | integration | 待验 |
| T1.6 | UC-1 | B NFR | 恶意输入被拦截返回 400 | Wave 1 | **integration** | 待验 |
| T1.8 | UC-1 | A 功能 | e2e 下单全链成功 | Wave 1 | e2e | 待验 |
| T2.5 | UC-2 | B NFR | 横向越权返回 403 | Wave 2 | **integration** | 待验 |

**状态字段：** `待验`（设计期默认）→ 实现期填 `PASS` / `FAIL` / `未实现` / `[DEVIATED]原因`
（`[DEVIATED]` = 编码中发现该用例设计错误/不可行，不能静默跳过——需登记原因 + 用户确认 + 是否回流⑤改设计）

**「功能归属 Wave」 vs 「测试执行层」双列（修归属歧义 G0）：**
- **功能归属 Wave** = 哪个 Wave 产出该用例对应的代码（Wave 完成判定用此）
- **测试执行层** = 该用例在哪个测试阶段跑（unit 在 dev 阶段 / integration 在 phase-test / e2e 在独立 e2e gate / perf-chaos 在压测环境）。取值从⑤§6 来源 B 的「强制层级」列继承（安全/并发强制 integration；e2e 类型用例走 e2e）。
- **为何拆**：同一用例的单元测试在该 Wave 的 dev 阶段跑、集成测试在 phase-test 跑——清单一列"归属 Wave"无法表达执行阶段差异，末尾验收 Wave 失败时无法定位是 unit 缺口（dev 责任）还是 integration 缺口（phase-test 责任）。含 UI-E2E 用例时，单列 DoD 不可满足（phase-test 排除 UI-E2E）。

**闭环要求：**
- 清单用例 ID 集合 = ⑤test-matrix 全量（来源 A + 来源 B），无遗漏无多余
- 每个功能 Wave 覆盖的用例 ID 都在本清单出现
- **末尾验收 Wave（见 Wave 编排）blocked_by 所有功能 Wave**，它的 PASS = 全清单 PASS
- **gate 范围按测试执行层切**：phase-test gate 只核 integration 层用例；unit 层在 Wave 内 dev 阶段核；e2e 层在独立 e2e gate 核；perf-chaos 层在压测环境核。末尾验收 Wave 汇总各层结果。**不切范围会导致含 e2e/perf 用例时 DoD 不可满足**（phase-test 明确排除 UI-E2E）。

## 执行交接（硬契约）

本计划完成后，进入编码实现。**编码完成的定义 = 测试验收清单全绿。**

- **无论方式 A/B，末尾验收 Wave（blocked_by 所有功能 Wave）未绿 = 实现未完成。**
  验收 Wave 的职责：读测试验收清单全量 → 跑测试 → 把每条 PASS/FAIL/缺失映射回用例 ID → 任一用例无对应测试或 FAIL = 整个实现未完成 → 输出覆盖率报告。
- **方式 A（推荐）**：接入 coding-workflow，启动 Phase 流程（spec→plan→dev→test→pr）。
  若存在本测试验收清单，Phase-test gate 必须以本清单为验收基线（清单用例全 PASS 才过），而非仅"测试套件通过"。
- **方式 B**：手动执行——每个 Wave 派一个 fresh subagent，按 Wave 内执行流走 TDD 链；末尾验收 Wave 同上。
- **偏离通道**：编码中发现用例设计错误/不可行，走 `[DEVIATED]` 登记（附原因 + 用户确认），不可静默跳过。
```
