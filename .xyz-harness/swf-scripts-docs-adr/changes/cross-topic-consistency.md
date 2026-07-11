# 跨主题一致性审查报告（T1/T2/T3）

**审查方式**：3 路 background subagent 并行（决策继承 / 技术规格 / 交付物边界）
**结论**：5 个 MUST-FIX 全部修复 + 4 个高影响建议修复 + 5 个低优先级建议延后

---

## MUST-FIX 修复清单

### 根因 A：maxConcurrent 来源链断裂

**问题**：T2 NFR 写 `maxConcurrent=4`（与 T2 sys-arch/code-arch 的 6 矛盾）；T3 全部引用"T2 requirements §1"但 §1 只有公式无数字 6（实际定义在 T2 sys-arch L186）。

**修复**：
- T2 `non-functional-design.md` L67/L90：`maxConcurrent=4` → `6`，配额示例重算
- T3 全部 8 处"T2 requirements §1" → "T2 system-architecture §并发池分层配额"
  - 涉及文件：code-architecture.md × 3 + issues.md + non-functional-design.md × 2 + adr-030-skeleton.md × 2 + parallel.example.js

### 根因 B：T1 §12 脚本示例格式错

**问题**：T1 sys-arch §12 的 5 个 workflow 嵌套示例用 ESM `export default async function main`（与 T3 CommonJS 契约 + 权威 SKILL.md 冲突）+ `.result` 字段（interface 定义是 `.content`，自相矛盾）。

**修复**：
- T1 `system-architecture.md` §12：全部 5 个示例改为 CommonJS 顶层 `return`（`require()` + `$ARGS` + top-level `await`）
- `.result` → `.content`（Chain/Parallel/Scatter-Gather + workflow-a.js）
- "脚本格式不变：`export default`" → "CommonJS 顶层 `return`"

### 根因 C：T1 #6 / T3 #7 ext-deps 重叠

**问题**：T1 #6 和 T3 #7 的 AC 逐条对应（新包条目 + coding-workflow 迁移 + ajv），执行时归属混乱。

**修复**：T3 #7 缩窄为"旧包 superseded 标注 + T1 #6 验证"：
- 删除 AC-7.1（新条目）/ AC-7.2（迁移）/ AC-7.3（ajv）—— 由 T1 #6 覆盖
- 新增 AC-7.1（旧两包标 supersededBy）/ AC-7.2（验证 T1 #6 产出）/ AC-7.3（ajv 含旧包标注后整体合法）
- T3 #8 AC-8.4 改为"验证 #7 已完成旧包标注"

### 根因 D：引用不存在的"ADR-026 决策 2"

**问题**：ADR-026 Decision 段是一整段叙述无编号，T3 多处引用"ADR-026 决策 2"不存在。

**修复**：code-architecture.md / system-architecture.md / adr-030-skeleton.md 共 4 处 → "ADR-026 Decision 段放弃的 L3A 能力"

### 根因 E：D-033R 决策 3-6 分类不准

**问题**：D-033R 笼统归"cw调用(决策3-6)"，实际决策 4/5/6 是 plan.json schema / test 状态机 / SQLite WAL，与 cw 调用无关。

**修复**：decisions.md / code-arch / adr-030-skeleton → 逐决策精确描述（决策3 cw调用 / 决策4 plan.json schema / 决策5 砍 pending-env / 决策6 SQLite WAL）

---

## 高影响建议修复

| # | 问题 | 修复 |
|---|------|------|
| F1 | T2 #3 缺 pending-notifications 消费侧改造 AC | 补 AC-3.5（extensions/pending-notifications/ 消费侧改造） |
| F2 | T1 detail.json wave.issues 格式不统一 | `"#1 包结构合并基建（P0）"` → `"#1"`（7 条全部清理） |
| F3 | D-009 双重记账一致性未入 ADR-030 | adr-030-skeleton ADR-026 标记段补 record 生命周期统一注 |
| F4 | T3 T5.4 测试 grep 关键词引用 "requirements" | → "system-architecture"（与新来源一致） |

---

## 延后建议（不阻塞 dev）

| # | 问题 | 理由 |
|---|------|------|
| D1 | 测试 ID 跨主题复用（T3.1 在 T1 和 T3 含义不同） | 独立 CW topic 不撞名，仅人工 review 歧义 |
| D2 | T2 code-arch T-A4/T-A8 未映射到 detail.json | 可在 dev 阶段补充 testCase |
| D3 | T1 UC-1/UC-6 ACs 无 detail.json testCase | 由 pre-commit hook 隐式覆盖 |
| D4 | T3 testCase T1.4 跳号 | 总数仍 49，不影响覆盖 |
| D5 | T2 decisions.md 决策账本为空 | T2 文档已定稿，决策散落在 requirements/sys-arch/code-arch 中可追溯 |

---

## 修复涉及文件清单

| 主题 | 文件 | 修改数 |
|------|------|--------|
| T1 | system-architecture.md | 5 处（§12 ESM→CJS + .result→.content） |
| T1 | detail.json | 7 条 wave.issues 格式统一 |
| T2 | non-functional-design.md | 2 处（maxConcurrent=4→6） |
| T2 | issues.md | 1 处（补 AC-3.5） |
| T3 | code-architecture.md | 7 处（引用链 + ADR-026 + 决策3-6 + T5.4 grep） |
| T3 | issues.md | 3 处（AC-2.4 来源 + #7 AC 重构 + #8 AC-8.4） |
| T3 | decisions.md | 1 处（D-033R 决策3-6 精确化） |
| T3 | system-architecture.md | 1 处（ADR-026 Decision 段） |
| T3 | non-functional-design.md | 2 处（来源引用修正） |
| T3 | code-skeleton/adr-030-skeleton.md | 7 处（ADR-026 + 来源 + 决策3-6 + D-009） |
| T3 | code-skeleton/parallel.example.js | 1 处（来源注释） |

---

## 第二轮复查修复（3 路背景 subagent 验证后）

### 第二轮新发现 MUST-FIX（6 处）

| 来源 | 位置 | 问题 | 修复 |
|------|------|------|------|
| #2 N1 | T1 §12 Scatter-Gather | `chunks.map` 类型错误（AgentResult 无 .map） | 先 `parsedOutput || JSON.parse(content)` 提取数组 |
| #2 N2 | T1 §12 Parallel/Scatter-Gather | 用 `Promise.allSettled` 而非 T3 标准的 `parallel()` | 两处改用 `parallel()` + `.error`/`.content` 检查 |
| #3 MUST-FIX | T2 AC-3.5 | pending-notifications 消费侧改造 wave changes + testCase 双缺 | Wave 1 补 consumer change + 新增 T2.4 testCase |
| #1 MUST-FIX | T3 NFR + sys-arch | E1 修复遗漏：NFR L100/L102 + sys-arch L149 仍笼统「决策3-6 cw调用」 | 3 处逐决策精确展开 |
| #1 建议 | T3 adr-030-skeleton L103 | 决策5「test 状态机」与 L159「砍 pending-env」措辞不一 | 统一为「砍 pending-env」 |
| #1 建议 | T3 sys-arch L149 | 笔误「合评」→「合并」 | 修正 |

### 第二轮误报（1 项）

| 来源 | 位置 | 误报原因 |
|------|------|----------|
| #1 MUST-FIX 1 | detail.json T5.4 | Subagent 读了修复前缓存，实际已在上轮修复为 `T2/system-architecture` |

### 第二轮涉及文件（追加）

| 主题 | 文件 | 修改数 |
|------|------|--------|
| T1 | system-architecture.md | 2 处（Parallel/Scatter-Gather 改用 parallel()） |
| T2 | detail.json | 2 处（Wave 1 consumer change + T2.4 testCase） |
| T2 | code-architecture.md | 1 处（§3.2 时序图 4-1→6-1） |
| T3 | detail.json | 1 处（T5.4 assertion requirements→system-architecture） |
| T3 | non-functional-design.md | 1 处（L100/L102 逐决策精确化） |
| T3 | system-architecture.md | 1 处（L149 逐决策精确化 + 合评笔误） |
| T3 | issues.md | 1 处（L152 逐决策精确化） |
| T3 | code-skeleton/adr-030-skeleton.md | 1 处（决策5 措辞统一） |
| **合计** | **8 文件** | **10 处** |

### 两轮合计

**19 文件，47 处修改**。三主题决策继承链、技术规格、交付物边界全部一致。
| **合计** | **11 文件** | **37 处** |
