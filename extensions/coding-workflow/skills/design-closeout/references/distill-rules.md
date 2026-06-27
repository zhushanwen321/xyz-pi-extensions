# 沉淀规则表（Distill Rules）

> design-closeout Step 2 的核心 spec。每条产出「提炼进哪 / 留 topic / 清理」的判据。
> 提取判据是关键——把"判断"降级成"查表"，AI 能执行，人只需对 ADR 选哪几条拍板。

## 总表

| 源 deliverable | 提炼进 | 提取判据（什么该留） | 留 topic（什么不该提） |
|---|---|---|---|
| ①requirements | PRODUCT.md | 产品愿景句 / 核心 Actor 表 / ①「约束&不做」里**跨主题稳定**的产品边界 | 本次用例/数据流/UI场景 |
| ①requirements | CONTEXT.md | 新术语（多次设计会复用的领域概念） | 本次临时名词 |
| ②system-arch | ARCHITECTURE.md | 分层/模块表/状态机当前态/领域模型 | 本次挑战/推演过程 |
| ③issues | `docs/adr/NNN-{slug}.md` | **P0/P1 且标 D-不可逆** 的方案取舍 | 已被推翻方案的分析细节 |
| ④nfr | NFR.md | **代码已验证**（Step1 过关）的约束 + 已知残余风险 | 本次特有、已解决的风险推演 |
| ⑤code-arch | `docs/architecture/sequence/` | 跨主题复用核心时序图（≤3张） | 本次特有调用链、签名表全表 |
| ⑥execution | TEST-STRATEGY.md | 验收清单中**破坏即事故**的基线用例 | Wave 编排（一次性） |

## 提取判据详解

### ①requirements → PRODUCT.md：产品级 vs 需求级

陷阱：requirements.md 不是 PRODUCT.md 的子集，两者是不同抽象层。

| | requirements.md（per-topic） | PRODUCT.md（项目级） |
|---|---|---|
| 回答 | **这一次**要做什么 | **这个产品**是什么 |
| 生命周期 | 快照（归档） | always-current |
| 读者 | 本次设计/编码 | 任何新需求的 ①clarity 开篇 |

**判断规则：** 某条信息去掉「本次主题名」后是否仍成立？
- 成立 → 产品级 → 提炼进 PRODUCT.md
- 不成立（依赖本次具体需求）→ 需求级 → 留 topic

**「非目标」是最有价值的提炼对象**——①「约束&不做」里的产品级非目标，累积即"这个产品明确不做什么"，防止功能蔓延。

### ②system-arch → ARCHITECTURE.md：当前态快照（覆盖更新）

ARCHITECTURE.md 是**当前态快照**，不是历史。本次设计的分层/模块表/状态机/领域模型**覆盖**对应章节（附一句变迁说明：本次新增/修改了什么）。

**状态机演进：** 不保留历史版本（历史在 ADR），只留当前态。重大变迁顺手抽一条 ADR 记录"为什么改状态机"。

### ③issues → ADR：不可逆决策（append-only）

**只抽 P0/P1 且标 D-不可逆的决策**（分层/状态机/领域边界/根本架构选择）。

ADR 记录"**为什么这么选**"（非"怎么做"——那是代码）。每条含：背景 / 决策 / 备选方案（取舍）/ 后果 / 溯源 `[from: {topic} §{issue}]`。

**被推翻的旧 ADR 不删除**（append-only），改 `status: superseded`，新 ADR 用 `supersedes` 指回。

### ④nfr → NFR.md：工程约束（最重要的容器）

**只沉淀 Step1 代码验证过关的约束**——`[UNVERIFIED]` 的不进。

每条约束四件套（缺"验证"= 空头约束，check 报错）：约束 / 为什么 / 验证 / 例外。

- **ID 累加制：** grep NFR.md 现有最大 ID（如 `S-3`），新约束从 `S-4` 起。
- **已知残余风险**独立成章，跨主题累积。

### ⑤code-arch → 时序图（跨主题复用）

只挑**跨主题复用**的核心时序图（新人理解系统必看），≤3张。签名表全表**不另存**——代码即真相，TS interface / 类型定义就是契约文档。

### ⑥execution → TEST-STRATEGY.md：不可回退基线

从 ⑥验收清单提炼**破坏即事故**的用例（非全部用例）：资金/数据安全类、核心不变式类、状态机关键转移类。

每条标：用例来源（⑥ID）/ 断言 / 破坏即（事故级别）/ 关联约束（NFR ID）。Wave 编排不提。

## 沉淀纪律

1. **强制溯源**——每条沉淀标注 `[from: {topic} §{章节}]`，缺溯源 check_closeout 报错
2. **去重**——沉淀前 grep 目标文档现有 ID，避免重复编号
3. **ask_user 确认**——沉淀是不可逆信息归位，每条提炼须人拍板（ADR 选哪几条尤其要问）
4. **覆盖 vs 追加**——ARCHITECTURE/PRODUCT/NFR/TEST-STRATEGY 是覆盖（always-current）；ADR 是追加（append-only）
