---
verdict: APPROVED_WITH_FIXES
reviewer: nfr-副作用+回灌指针路（独立，上下文隔离）
upstream: non-functional-design.md
cross_ref: issues.md, system-architecture.md, code-architecture.md, code-skeleton/*, decisions.md
---

# Review — NFR 副作用分析 + 回灌指针链路（mid-detail-plan NFR 路）

> 决策账本纪律已遵守：D-001~D-008 无 gap 重报。D-001/D-002 status=revisited（被 D-005/D-006 superseded）处置正确，未当 gap 重报。
>
> 审查范围：7 维度覆盖完整性 × 5 issue + 回灌指针核对（⑤test-matrix / ⑤骨架约束 → code-arch §6 来源 B + code-skeleton）+ 副作用深度 + 残余风险合理性。

## Verdict

**APPROVED_WITH_FIXES** — 维度覆盖完整、回灌指针链路闭合、副作用分析深度达标。**1 条 must_fix（F-指针幽灵）+ 2 条 should_fix（F-残余风险过时 / F-描述与 code-arch 实测不一致）**。均为文档一致性修正，不影响骨架接线与实现路径，不阻塞 detail gate 流转。

## 维度覆盖核对

### 矩阵完整性（5 issue × 7 维度 = 35 格）

全格覆盖，无空缺。N/A（—）格数 = 0——矩阵未用 N/A 标记，而是对「数据 / 并发 / 可观测」三个跨 issue 恒 ✅ 的维度采用**全局定性说明**（矩阵下方 blockquote）集中论证，避免逐条重复。这是合理的覆盖策略（非偷懒跳过），理由如下：

| 全局 ✅ 维度 | 论证依据 | 核对结论 |
|-------------|---------|---------|
| 数据（全 ✅） | 进程内 TUI 组件，无 DB / 无持久化 / 无跨表事务，状态随 component 销毁 | ✅ 成立（system-architecture §8 无 DB 边界，§6 无持久化层）|
| 并发（全 ✅） | 单 session 同步事件循环，handleInput 单调用栈串行；`_resolved` 终态守卫（BC-6）覆盖 FR-12 重入 | ✅ 成立（BC-6 保持不动已登记 system-architecture §12）|
| 可观测（全 ✅） | TUI 组件无结构化日志/metrics/tracing 需求 | ✅ 成立（renderCall/renderResult 是 UI 输出非可观测信号）|

⚠️ 维度（安全/稳定性/兼容性）逐 issue 给出风险 + 缓解，无遗漏。性能维度全 ✅（parseKey 纯函数字符串匹配，人类打字频次远低于刷新阈值）论证准确。

**结论**：维度覆盖 PASS。35 格全覆盖，3 个全局 ✅ 维度的豁免论证充分（非 N/A 跳过）。

## 回灌指针核对

### ⑤骨架约束（2 条）→ code-skeleton 实证

| nfr 缓解项 | 指向 | code-skeleton 实证 | 状态 |
|-----------|------|-------------------|------|
| QuestionState.draftText 初始化 `""`（防 undefined 传播） | types.ts createQuestionState() | `code-skeleton/types.ts:95` `draftText: ""` + `:82` `draftText: string` 强类型字段 | ✅ 落地（F-骨架约束） |
| （隐含）无 `this.editorText` 残留 | component.ts | `code-skeleton/component.ts` grep `this\.editorText\|private editorText` 仅命中注释（`// [REMOVED #2]`、`// 替代 this.editorText`），无真实代码行 | ✅ 落地（F-骨架约束，tsc + AC-2.5 grep 双兜底） |

### ⑤test-matrix（8 条代码测试缓解项）→ code-arch §6 来源 B + §6 用例表

| nfr 缓解项 | nfr 落地指针 | code-arch §6 对应用例 | 状态 |
|-----------|------------|---------------------|------|
| BC-3 控制字符过滤保持 | C-PASTE-1~7 | §6 UC-1 表 C-PASTE-1~7（7 用例齐全）| ✅ |
| parseKey 命中 special no-op | **C-ARROW-1/1.2** | §6 UC-2 表 **C-ARROW-1 / C-ARROW-2**（无 1.2）| ❌ **见 must_fix #1** |
| no-op 集合遍历 | AC-1.3（C-KEYMAP-*）| §6 UC-2 表 C-KEYMAP-UP/DOWN/LEFT/HOME/END/INSERT/PGUP/PGDN/F1/DELETE（10 用例）| ✅ |
| modifier 矩阵 18 用例 | AC-1.4（C-KEYMAP-MOD）| §6 UC-2 表 C-KEYMAP-MOD（18 细分用例）| ✅ |
| 单字符 printable 追加 | C-PASTE-1（单字符）| §6 UC-1 表 C-PASTE-5（单字符 backward-compat，draftText === "x"）| ⚠️ **见 should_fix #1**（指针可用但 nfr 描述过时） |
| bracketed paste 剥离（BC-1/BC-2）| C-PASTE-2~7 | §6 UC-1 表 C-PASTE-2~7 | ✅ |
| 无 this.editorText 残留 | AC-2.5（grep）| §7 现有代码映射表 + system-architecture §11 AC-2 | ✅ |
| 分流预填（禁 fallback 链）| AC-2.1/2.2 + AC-2.4（C-DRAFT/C-BC4C）| §6 UC-3 表 C-DRAFT-1/C-DRAFT-2/C-BC4C | ✅ |
| handleInput ≤ 40 行 | AC-3.1（sed 行数）| system-architecture §11 AC-4 | ✅ |

**code-arch §6 来源 B 回灌闭合性**：来源 B placeholder 文本声明「8 条代码测试缓解项与来源 A 完全重叠」，逐一核对 8 条全部能在来源 A（§6 各 UC 表）找到对应用例 ID，无 PHANTOM（除 must_fix #1 的 ID 笔误外，用例实体存在）。

## must_fix

### #1 [F-指针幽灵] nfr 回灌表「C-ARROW-1/1.2」ID 不存在于 code-arch

**位置**：non-functional-design.md 回灌表第 2 行（parseKey 命中 special 时 no-op return）
**问题**：落地指针写 `C-ARROW-1/1.2`，但 code-arch §6 UC-2 表的实际用例 ID 是 `C-ARROW-1` 和 `C-ARROW-2`（无 `C-ARROW-1.2`）。`1.2` 形似 AC 编号（AC-1.2）误植到用例 ID。
**影响**：回灌指针指向不存在的用例 ID，⑤test-matrix 落地校验时会找不到 `C-ARROW-1.2` → 误判为缺失。
**修正**：`C-ARROW-1/1.2` → `C-ARROW-1/2`（对齐 code-arch §6 UC-2 表的实际 ID）。
**类型**：F（文档一致性，D-可逆）

## should_fix

### #1 [F-残余风险过时] 「单字符 printable 返回行为」不应列为残余风险

**位置**：non-functional-design.md §#1 稳定性 line 54 + 残余风险登记表第 1 行
**问题**：nfr 把「parseKey 对 bare printable 单字符的返回行为」写成**待确认**（「需确认：若返回 `"a"`…」），并据此把「单字符不追加」登记为残余风险。但 code-arch §1 已通过**实测 SDK 源码（`keys.js:1093-1096`）**确认 parseKey 对单字符 ASCII printable（code 32-126）返回该字符本身（非 undefined）——这不是「需确认」的假设，是已实证的事实。
**证据链**：
- code-arch §1：「实测 SDK 源码（keys.js:1093-1096）确认 parseKey 对单字符 ASCII printable 返回该字符本身」
- code-arch §3 伪签名：`if (keyId.length === 1 && keyId >= " " && keyId <= "~") { state.draftText += keyId; }`（单字符追加分支已接线）
- code-skeleton/component.ts:268 注释：「单字符 printable：parseKey 返回该字符本身（code 32-126）」+ 实际接线
- code-arch §6 C-PASTE-5 用例：单字符 "x" → draftText === "x"（正向回归锁定）

nfr 与 code-arch 是并行产出的上下游（nfr upstream=issues，code-arch upstream=issues），nfr 写作时 code-arch 的实测结论尚未回流。现在 code-arch 已定稿，nfr 的「待确认 + 残余风险」表述滞后。
**影响**：残余风险登记表第 1 行「SDK parseKey 改变 bracketed paste / bare printable 返回语义」的接受理由仍成立（SDK 未来版本漂移是真实残余风险），但「bare printable 返回行为需确认」这部分应从「残余风险」降级——当前版本行为已实测确认，由 C-PASTE-5 回归锁定，不是未确认假设。
**修正建议**：
1. §#1 稳定性 line 54 第 3 点：把「需确认」改为「已确认（code-arch §1 实测 SDK keys.js:1093-1096）」，C-PASTE-1 保持绿是回归验证而非首次确认。
2. 残余风险登记表第 1 行：保留该行（SDK 未来版本漂移是合理残余风险），但「影响」列「单字符不追加」可弱化——当前版本已验证，漂移由 C-PASTE-5 兜底。
**类型**：F（文档时效性，D-可逆）。不阻塞——nfr 的结论方向正确（单字符确实要追加），只是「确认状态」表述滞后于 code-arch 实测。

### #2 [F-描述不一致] nfr §#1 安全 line 37 「parseKey 命中 special 直接 no-op」遗漏单字符分支

**位置**：non-functional-design.md §#1 安全影响缓解方案第 2 点（line 37）
**问题**：nfr 写「parseKey 命中 special（返回非 undefined）时直接 no-op return，不进入 printable 追加」。这与 issues.md #1 方案 A 原文一致，但 code-arch §1 已修正该描述——parseKey 返回非 undefined 有**两种**情况：(a) special key（no-op）；(b) 单字符 ASCII printable（**追加，非 no-op**）。nfr 的「直接 no-op」描述对单字符 printable 不成立。
**影响**：安全论证的逻辑链有一处不精确——「敏感字节流若是特殊键码形态被整体丢弃」对 special key 成立，但单字符 printable（如密码的单个字符）parseKey 返回该字符本身会进入追加分支（这是编辑器本职，非泄漏）。nfr 的结论（不逐字符泄漏）仍成立，但论证路径缺了单字符分支这个 case。
**修正建议**：line 37 第 2 点补充「除单字符 ASCII printable（code 32-126，parseKey 返回该字符本身，正常追加）外，parseKey 命中 special 时直接 no-op return」，与 code-arch §1 实测结论对齐。
**类型**：F（描述精度，D-可逆）。不阻塞——安全结论方向正确（敏感内容渲染是编辑器本职，已在残余风险第 2 行登记 masked-input），只是论证分支缺一个 case。

## 其余核对项（均 PASS，无需改）

### 副作用分析深度

| 核对点 | nfr 论述 | 核对结论 |
|--------|---------|---------|
| #1 bracketed paste parseKey 返回值 | 「bracketed paste 序列 parseKey 返回 undefined（非已知 special key），随后靠 replace 剥离」| ✅ 准确（`\x1b[200~` 是多字符序列，parseKey 不匹配任何 special → undefined，与 code-arch §4 时序图 2 一致）|
| #1 SDK keyId 格式稳定性 | 「parseKey 与 matchesKey 同源（均 pi-tui），keyId 格式由同一模块定义，parseKey 产出的 keyId 必然能被 matchesKey 消费」| ✅ 论证成立（同模块无跨模块命名漂移）|
| #2 draftText 迁移兼容性 | createQuestionState 初始化 + 渲染参数链 + AC-2.5 grep 兜底 | ✅ 三重兜底（强类型 + grep + 测试），code-skeleton 已实证初始化与无残留 |
| #1 parseKey 纯函数性能 | 「纯函数字符串匹配，无 IO/无正则回溯灾难，单次 < 微秒级」| ✅ 准确 |

### 残余风险合理性

| 残余风险 | 接受理由 | 核对结论 |
|---------|---------|---------|
| SDK parseKey 未来版本改变返回语义 | SDK 是稳定公共 API（§8 契约=稳定）；C-PASTE-1~7 + C-ARROW 套件回归防线 | ✅ 接受理由成立（应保留，见 should_fix #1 的表述修正）|
| draftText 渲染敏感内容（masked-input）| 编辑器本职是显示用户输入；masked-input 是独立未来 feature（不在本次范围）| ✅ 接受理由成立（requirements Out of Scope 未列但属未来 feature，nfr 已诚实登记而非隐瞒）|

## 维度覆盖核对汇总

- 7 维度 × 5 issue = 35 格：全覆盖（3 维度全局 ✅ 论证 + 4 维度逐 issue 详析）
- N/A 豁免：0（采用全局定性说明替代逐条 N/A，策略合理）
- 回灌指针：⑤骨架约束 2 条全落地（code-skeleton 实证）+ ⑤test-matrix 8 条（7 条闭合 + 1 条 ID 笔误）
- PHANTOM 指针：1 条（C-ARROW-1.2，must_fix #1，用例实体存在仅 ID 写错）
- 副作用深度：bracketed paste / keyId 稳定性 / draftText 迁移三点分析准确
- 残余风险：2 条接受理由均成立

**终判**：APPROVED_WITH_FIXES。must_fix #1（ID 笔误）必须改；should_fix #1/#2（表述滞后于 code-arch 实测）建议改以保持上下游一致。三者均为 F 类文档修正，不改骨架接线、不改实现路径、不引入新风险，不阻塞 detail gate 流转。
