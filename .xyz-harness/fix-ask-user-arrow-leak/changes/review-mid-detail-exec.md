---
verdict: changes_requested
reviewer: independent-reviewer (Wave依赖+测试闭环)
upstream: [execution-plan.md, code-architecture.md, issues.md]
downstream: coding-execute
backfed_from: []
---

# Review — execution-plan（Wave 依赖 + 测试闭环）

## Verdict

**CHANGES_REQUESTED**

编排结构与测试闭环两维度整体扎实：Wave 0/1/2/3 串行链与 issues 依赖图 `#1→#2→{#3,#4}`、`#1→#5` 一致；测试用例 ID 集合与 code-arch §6 test-matrix（来源 A）逐 ID 吻合，来源 B 声明与来源 A 重叠无独立项；并行组（key-leak/paste/draft/hint/regression）语义清晰无资源冲突；C-REG-ALL（现有 180）兜底 Wave 1/2 行为等价的能力经核验成立（现有 180 覆盖 parseKey printable 提取 + draftText 迁移 + handleInput 拆分的行为面；方向键新行为由 C-ARROW 独立正向补缺，分工合理）。

但有 1 项 must_fix（dependsOn 数据准确性）+ 1 项 should_fix（同 Wave 内串行约束未显式化）。决策账本 D-001~D-008 已 confirmed，未当 gap 重报。

## must_fix

### MF-1 [D-缺陷] C-HINT-1/2 dependsOn 漏标 #2

**位置**：execution-plan.md 全量验收清单（L155-156 附近）

**现状**：
```
| C-HINT-1 | unit | W2 | freeform 提示行 | — | hint |
| C-HINT-2 | unit | W2 | comment 提示行 | — | hint |
```

**code-arch §6 UC-4 原文**：
```
| C-HINT-1 | 正常 | unit | freeform 提示行 | ... | AC-4.1 | #2,#4 | hint |
| C-HINT-2 | 正常 | unit | comment 提示行 | ... | AC-4.2 | #2,#4 | hint |
```

code-arch 明确 C-HINT-1/2 关联 issue `#2,#4`——它必须依赖 #2（draftText 迁移后 render 透传 state.draftText 才能正确渲染编辑器块）+ #4（提示行文案扩展）。

**问题**：execution 标 `dependsOn: —` 意味着 C-HINT 理论上可在 Wave 1 跑。但 Wave 1 既未改提示行文案（#4 在 Wave 2），也未迁移 draftText（#2 在 Wave 2），C-HINT 若在 Wave 1 执行必然红。dependsOn 漏标违反「用例依赖反映真实代码依赖」原则，编排工具若按 dependsOn 调度会误判可前置。

**修复**：全量清单 C-HINT-1/2 的 dependsOn 列改为 `#2,#4`（或 issue 维度的 `C-DRAFT-1`，因 #2 的渲染验证经由 C-DRAFT 链）。

**影响范围**：仅数据字段修正，不影响 Wave 归属（C-HINT 仍在 Wave 2 验收门），不影响实际测试执行顺序。

## should_fix

### SF-1 [K-风格] Wave 2 内部 #2→{#3,#4} 串行约束未显式化

**位置**：execution-plan.md Wave 2 段（L60-76）

**现状**：
```
**Issues**: #2（P1）+ #3（P1）+ #4（P1）
**Blocked by**: Wave 1
```

用 `+` 并列 #2/#3/#4，暗示三者可并行 commit。但 issues.md 依赖图明确：
- #3 blocked_by #2（#3 拆分依赖 #2 的 state.draftText，否则 handleOptionsInput 抽出后引用未迁移的 editorText）
- #4 blocked_by #2（#4 提示行依赖 #2 的 render 渲染参数链 state.draftText）

文字描述（L72「#3 抽 handleOptionsInput」、L76「#4 help 行扩展」）隐含 #2 先行，但结构化字段（Issues 行用 `+`）与 blocked_by 矛盾。

**风险**：implementer 若按 `+` 误判为可并行 commit，#3/#4 会基于 #2 未完成的代码构建（state.draftText 字段不存在 → 编译失败，或 editorText 字段未移除 → AC-2.5 grep 失败）。实际因编译/反模式门会捕获，不会静默出错，但浪费一轮。

**修复**：Wave 2 Issues 行改为显式顺序标注，例如：
```
**Issues**: #2（draftText 迁移，先）→ #3（handleInput 拆分，搭 #2 便车）+ #4（提示行，搭 #2 便车）
**内部顺序**: #2 commit 后 #3/#4 可并行
```

或在 Wave 2 段加一行「Wave 2 内部依赖：#3、#4 均 blocked_by #2，#2 必须先 commit」。

**性质**：K 级（风格/可读性）。同 Wave commit 顺序最终由 implementer 按 issues blocked_by 推断，显式化降低误读概率。

## 测试闭环核对表

### 用例 ID 集合等价性（code-arch §6 来源A ↔ execution 全量清单）

| code-arch §6 来源A 用例 | execution 全量清单 | 一致性 |
|---|---|---|
| C-ARROW-1 | ✓ W1 | ✓ |
| C-ARROW-2 | ✓ W1 | ✓ |
| C-KEYMAP-UP/DOWN/LEFT/HOME/END/INSERT/PGUP/PGDN/F1/DELETE（10） | ✓ W1 各列 | ✓ |
| C-KEYMAP-MOD（18 modifier 用例） | ✓ W1 | ✓ |
| C-PASTE-1~7（7，现有用例复跑） | ✓ W1 | ✓ |
| C-DRAFT-1/2 | ✓ W2 | ✓ |
| C-BC4C | ✓ W2 | ✓ |
| C-HINT-1/2 | ✓ W2 | **dependsOn 漏标**（MF-1） |
| C-REG-ALL | ✓ W3 | ✓ |
| **合计** | 逐 ID 吻合 | ID 集合等价 ✓ |

来源 B：code-arch §6 声明「NFR 风险全部落在功能行为上，8 条代码测试缓解项与来源 A 完全重叠，2 条骨架约束项由 tsc + AC-2.5 grep 验收」。无独立用例。✓

### Wave 验收门覆盖度

| Wave | 改动 issue | 验收门覆盖 | 判定 |
|---|---|---|---|
| Wave 1 | #1（parseKey 拦截） | C-ARROW/C-KEYMAP/C-KEYMAP-MOD（负向）+ C-PASTE-1~7（行为等价）+ 现有180 | ✓ 全覆盖（#1 四态路由：special→C-ARROW/C-KEYMAP，单字符→C-PASTE-5，undefined→C-PASTE-1~7，语义键→C-REG-ALL 内 freeform/comment 用例） |
| Wave 2 | #2（draftText）+ #3（拆分）+ #4（提示行） | C-DRAFT-1/2 + C-BC4C（#2）+ AC-2.5 grep（#2 反模式）+ AC-3.1 行数（#3 反模式）+ C-HINT-1/2（#4）+ 现有180（#2/#3 行为等价） | ✓ 全覆盖 |
| Wave 3 | #5（回归收尾） | C-REG-ALL（180）+ 全部新用例复跑 + AC-1~4 反模式 + typecheck + lint | ✓ 全覆盖 |

### C-REG-ALL 兜底能力核验

| 兜底对象 | 现有180覆盖面 | 兜底判定 |
|---|---|---|
| #1 parseKey printable 提取分支 | C-PASTE-1~7 + freeform/comment 输入用例 | ✓ 覆盖（行为等价） |
| #1 parseKey special no-op（新行为） | 现有180无方向键用例 | ✗ 不覆盖——但由 C-ARROW/C-KEYMAP 正向独立补缺，分工合理，非缺陷 |
| #2 draftText 迁移 | freeform/comment 导航 + 输入用例 | ✓ 覆盖（迁移前后行为等价） |
| #3 handleInput 拆分 | options/freeform/comment/submit 全路径用例 | ✓ 覆盖（纯移动） |

C-REG-ALL 对「不破坏已有行为」兜底成立；方向键修复的「新行为」由 C-ARROW/C-KEYMAP/C-KEYMAP-MOD 独立正向验证，两层互补。✓

### 反模式检查 AC-1~4 归属合理性

| AC | 检查内容 | 改动归属 Wave | execution 检查归属 | 判定 |
|---|---|---|---|---|
| AC-1 | parseKey import=1 | W1 | W3 全量 | ✓ 合理（W1 改 import，W3 复核；W1 验收门未单列但 typecheck 隐含） |
| AC-2 | 无 this.editorText | W2（#2 移除字段） | W2（AC-2.5）+ W3 复核 | ✓ W2 本地门已覆盖，W3 冗余复核安全 |
| AC-3 | 无 parse-key.ts | W1（不新建） | W3 全量 | ✓ 合理（始终无此文件，W3 确认） |
| AC-4 | handleInput ≤40行 | W2（#3 拆分） | W2（AC-3.1）+ W3 复核 | ✓ W2 本地门已覆盖，W3 冗余复核安全 |

AC-1 在 W1 无本地门、仅 W3 检查——轻微张力（W1 commit 时 parseKey import 若写错要到 W3 才发现），但 W1 typecheck + C-ARROW/C-KEYMAP 必然触发 parseKey 调用，import 错会在 W1 测试阶段暴露。可接受。

### 并行组合理性

| parallelGroup | 成员 | 共同资源/测点 | 冲突 | 判定 |
|---|---|---|---|---|
| key-leak | C-ARROW + C-KEYMAP-* + C-KEYMAP-MOD | 同测 parseKey 拦截 special key | 无 | ✓ |
| paste | C-PASTE-1~7 | 同测 printable 提取分支 | 无 | ✓ |
| draft | C-DRAFT-1/2 + C-BC4C | 同测 state.draftText 跨tab/预填 | 无 | ✓ |
| hint | C-HINT-1/2 | 同测渲染提示行 | 无 | ✓ |
| regression | C-REG-ALL | 全量复跑 | 独立 | ✓ |

### dependsOn 准确性

| 用例 | execution dependsOn | 真实依赖 | 判定 |
|---|---|---|---|
| C-ARROW-1/2 | — | parseKey 路由（W1 本 Wave） | ✓ |
| C-KEYMAP-* | — | 同上 | ✓ |
| C-KEYMAP-MOD | — | 同上 | ✓ |
| C-PASTE-1~7 | — | parseKey printable 提取（W1，现有用例复跑） | ✓ |
| C-DRAFT-1 | C-ARROW-1 | parseKey 路由稳定后验 draftText 持久 | ✓ |
| C-DRAFT-2 | C-ARROW-1 | 同上 | ✓ |
| C-BC4C | C-DRAFT-1 | draftText 机制验完再验 comment 预填 | ✓ |
| **C-HINT-1** | **—** | **#2 render 透传 + #4 文案** | **✗ MF-1** |
| **C-HINT-2** | **—** | **同上** | **✗ MF-1** |
| C-REG-ALL | W1+W2 | 全部改动就位 | ✓ |

---

## 总结

| 维度 | 判定 |
|---|---|
| Wave 依赖与 code-arch §8 时序图一致性 | ✓ 一致（Wave1 无依赖，Wave2 blocked_by Wave1 对应时序图3依赖时序图1/2） |
| Wave 2 内部 #2→{#3,#4} 串行 | △ 隐含未显式（SF-1） |
| 测试用例 ID 集合等价 | ✓ 逐 ID 吻合 |
| Wave 验收门覆盖度 | ✓ 各 Wave 覆盖其改动全用例 |
| C-REG-ALL 兜底能力 | ✓ 成立（与 C-ARROW 正向互补） |
| 反模式 AC-1~4 归属 | ✓ 合理（AC-2/4 在 W2/W3 双重，冗余安全） |
| 并行组合理性 | ✓ 无冲突 |
| dependsOn 准确性 | ✗ C-HINT 漏标（MF-1） |

**阻塞项**：MF-1（dependsOn 数据准确性，必修）。SF-1（同 Wave 内部顺序显式化，建议修）。

修复 MF-1 + SF-1 后可流转 coding-execute。
