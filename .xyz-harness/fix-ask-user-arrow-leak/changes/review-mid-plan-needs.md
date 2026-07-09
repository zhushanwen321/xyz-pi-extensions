# 需求完整性路审查 — requirements.md

**审查者**: reviewer (需求完整性路，上下文隔离)
**审查对象**: `.xyz-harness/fix-ask-user-arrow-leak/requirements.md`
**交叉验证源**: `component.ts` / `question-view.ts` / `types.ts` / `__tests__/*` / pi-tui `keys.d.ts` (v0.78.1 + v0.73.1)
**决策账本纪律**: D-001~D-004 status=confirmed，不当 gap 重报。本报告新证据推翻时标 [REVISIT of D-NNN]。

---

## Verdict

**CHANGES_REQUESTED**

存在 2 条 must_fix（阻断 mid-plan 进入 architecture/下游）+ 4 条 should_fix + 3 条 nit。

核心问题集中在两点：
1. AC-2.3「遍历全部 special key + modifier 组合」声明了覆盖范围，但 special key 清单与 pi-tui `KeyId` 实际清单**不一致**（漏 `esc`/`return`/`clear`，多了需求自己写的别名歧义），且 modifier 组合是指数级空间，AC 未定义采样策略 → 不可执行。
2. G2.1「引入 `parseKey` 统一解析层」与需求 §8「本次在 ask-user 内本地实现 parse 逻辑」存在**事实矛盾**：pi-tui 已经导出 `parseKey(data): string | undefined`，需求假设它不存在。这是方案选型的前提错误，必须在 plan 前澄清。

G3 的迁移点在需求里只提了 component.ts，漏了 question-view.ts 的 `editorText` 参数链——但这是 should_fix（实现时会自然撞上，不阻断 plan，只是需求没显式记录）。

---

## must_fix

### MF-1 [F/事实] AC-2.3 的 special key 清单与 pi-tui `KeyId` 不一致，且 modifier 组合无采样定义 → AC 不可执行

**问题**:

AC-2.3 原文：「遍历全部 special key（up/down/left/right/home/end/delete/insert/pageUp/pageDown/f1-f12）+ 常见 modifier 组合」

pi-tui `keys.d.ts`（v0.78.1，项目 paths 映射目标）实际 `SpecialKey` 清单：
```
"escape" | "esc" | "enter" | "return" | "tab" | "space" | "backspace" |
"delete" | "insert" | "clear" | "home" | "end" | "pageUp" | "pageDown" |
"up" | "down" | "left" | "right" | "f1".."f12"
```

对比 AC-2.3 的清单，差异：
- **漏 4 个**：`escape`/`esc`（编辑器 Esc 走专门分支，但 AC 声称「遍历全部 special key」应包含）、`enter`/`return`（同上）、`tab`、`clear`。其中 `enter`/`escape` 在编辑器内有专门语义（提交/退出），不属于「no-op」集合——这正好说明 AC-2.3「全部 no-op」的表述把两类语义不同的键混进同一句，机器测试时会撞矛盾（Enter 不是 no-op，是 submit）。
- AC 列的 `f1-f12` 是 12 个，pi-tui 也是 12 个，一致。

modifier 组合空间：
- `ModifierName = "ctrl" | "shift" | "alt" | "super"`，`ModifiedKeyId` 是这 4 个的**幂集**（2^4 - 1 = 15 种 modifier 子集）× 每个 BaseKey。
- AC 说「常见 modifier 组合」但没定义「常见」=哪几组。C-KEYMAP-MOD 举例「alt+x / ctrl+shift+arrow」，但没给完整采样矩阵。
- 指数空间 + 无采样定义 = AC 不可机器执行（测试写不全，reviewer 无法判定 done）。

**理由**: AC 的核心价值是「可验证」。这条 AC 现状既漏键又对 modifier 空间无界，实现者无法判定「覆盖到什么程度算 AC-2.3 通过」。

**建议修复**:
1. 把编辑器内的键分两类写清：
   - **special key（no-op 集合）**：明确列出 pi-tui `SpecialKey` 中编辑器应 no-op 的子集（排除 enter/escape/backspace/tab——这些在编辑器有专门语义，不是 no-op）。给出精确清单，不要用「全部」这类含糊词。
   - **有语义键（非 no-op）**：enter(提交)/escape(退出)/backspace(删尾)/tab(当前 no-op 但属导航语义) 单列，引用对应 AC。
2. modifier 组合：定义有限采样矩阵。建议「4 modifier 各单独 × up/down/left/right + 2-modifier 组合（ctrl+shift / ctrl+alt / shift+alt）× up/down」共约 20-30 个用例，写进 AC-2.4 的可枚举清单，而非「常见」。

### MF-2 [F/事实 + REVISIT of D-002] pi-tui 已导出 `parseKey`，G2.1 与 §8 的方案前提矛盾

**问题**:

G2.1：「引入 `parseKey(data)` 统一解析层（结构化按键事件）」
§8 Out of Scope：「不做 pi-tui 上游提 `parseKey` 公共 API…本次在 ask-user 内本地实现 parse 逻辑」

但 pi-tui `keys.d.ts`（v0.78.1 + v0.73.1 均有）已导出：
```typescript
export declare function parseKey(data: string): string | undefined;
// 返回 keyId 字符串（如 "ctrl+c"、"up"）或 undefined（不可识别）
```

实测确认：`@mariozechner/pi-tui@0.73.1` 和 `@earendil-works/pi-tui@0.78.1` 都有此函数。项目 `tsconfig.json` paths 映射 `@mariozechner/pi-tui` → 真实 pi-tui dist。

**矛盾点**:
- 若 pi-tui `parseKey` 返回 `string | undefined`（keyId 字符串），它**就是** G2.1 想要的「结构化按键事件」解析层。需求说「本地实现 parse 逻辑」是在重复造已有的轮子。
- D-002 confirmed「parseKey 覆盖 modifier 组合键」——但没说清是「pi-tui 的 parseKey」还是「自建的 parseKey」。如果用 pi-tui 的，modifier 覆盖是免费的（parseKey 已处理）；如果自建，D-002 才有意义。

**[REVISIT of D-002]**: D-002 的 rationale「matchesKey 已支持 modifier 前缀解析；不覆盖则 alt+x 仍泄漏」是基于「需要自己处理 modifier」的假设。若改用 pi-tui `parseKey`，modifier 处理由 pi-tui 负责，D-002 的 rationale 需要重写为「确认 pi-tui parseKey 的 modifier 覆盖范围」而非「自建覆盖」。

**理由**: 这是方案选型的前提。G2 的「白名单架构」实现路径完全不同：
- 路径 A（用 pi-tui parseKey）：`parseKey(data)` → 命中 special key → no-op；命中 printable → 追加；undefined → 丢弃。几乎零解析逻辑。
- 路径 B（自建 parse）：要在 ask-user 内复刻 pi-tui 的 Kitty/legacy 序列解析，违反 CLAUDE.md「必须复用 matchesKey，不得自己解析终端转义序列」约束（§7 技术约束第 1 条）。

需求 §7 明确禁止自建解析，但 §8 又说要本地实现 parse 逻辑——**自相矛盾**。plan 阶段必须先消解。

**建议修复**:
1. 在需求里记录事实：pi-tui 已导出 `parseKey(data): string | undefined`。
2. G2.1 改为：基于 pi-tui `parseKey` 构建路由层（消费其返回的 keyId，分发到 handler），而非「引入解析层」（解析层已存在）。
3. §8 删除「本次在 ask-user 内本地实现 parse 逻辑」或改为「本次在 ask-user 内基于 pi-tui parseKey 构建路由层，不向上游提新 API」。
4. D-002 补充说明：modifier 覆盖由 pi-tui parseKey 提供，ask-user 侧不自行解析。

---

## should_fix

### SF-1 [F/事实] G3 迁移点漏列 question-view.ts 的 `editorText` 参数链

**问题**: G3.2「移除组件级 editorText 重建赋值」+ 数据流图只画了 component → QuestionState.draftText。但 `editorText` 的消费链横跨两个文件：

`component.ts` (10 处赋值) → `renderQuestionView(..., this.editorText)` → `question-view.ts`:
- `renderQuestionView(editorText)` 参数
- `buildOptionLines(editorText)` 参数
- `buildSplitPane(editorText)` 参数
- `buildEditorBlock(editorText)` 参数

迁移 draftText 后，这条参数链要么改为传 `state.draftText`，要么 renderQuestionView 改签名从 state 读。需求没记录这个跨文件改动面，实现时可能漏改 question-view.ts 导致渲染读不到草稿。

**理由**: 需求的数据流图应反映真实流转路径。漏列会导致 plan 阶段低估改动范围。

**建议**: 数据流图补 question-view.ts 作为 draftText 的消费者；G3.2 补「renderQuestionView 及其下游 build* 函数的 editorText 参数改为读 state.draftText」。

### SF-2 [F/事实] AC-1.3「181 个现有测试全绿」与实际 180 个不符

**问题**: 实测 `grep -rh "^\s*it(" extensions/ask-user/src/__tests__/*.test.ts | wc -l` = 180（component 69 + e2e 8 + index 25 + question-view 41 + submit-view 17 + types 7 + validate 16）。

需求 G1 / AC-1.3 多处写「181」。差 1 个。

**理由**: 回归基线数字必须准确，否则「全绿」判定无锚点（reviewer 无法核对 181 从哪来）。

**建议**: 改为 180，或注明统计口径（是否含 describe、是否含 test() 别名）。

### SF-3 [K/知识] UC-3 的 AC 与「现有行为等价」缺乏可验证锚点

**问题**: AC-3.1「Q1 freeform 草稿 + 切走再回来，draftText 恢复」+ AC-3.2「Q1 和 Q3 各有草稿，互相独立」是新增测试。但 UC-3 替代流程写「Esc 退出 freeform → 切 tab → 回来重进，editorText 预填上次未提交内容（与现状行为等价）」。

现状（component.ts `handleInput` Other Enter 分支）：`this.editorText = state.freeTextValue ?? ""`——预填的是**已提交保存的 freeTextValue**，不是「未提交草稿」。当前 editorText 是组件级单实例，切 tab 后回来重进会读 freeTextValue（已保存值），而未提交的输入在切 tab 时**会丢失**（editorText 被 Esc/Enter 清空，或切 tab 时未被保存）。

所以 UC-3 描述的「未提交草稿保持」其实是**新行为**（draftText 持久化未提交输入），不是「与现状等价」。需求把新行为包装成「等价」，会误导 reviewer 以为是回归测试，实际是功能变更。

**理由**: refactor 的「行为等价」边界必须清晰。把新行为标成等价会让 test 阶段误判（现状根本不支持跨 tab 草稿保持）。

**建议**: UC-3 替代流程改为「Esc 退出 freeform 时丢弃未提交输入（与现状一致）；已保存的 freeTextValue 切 tab 后回来仍可预填（与现状一致）。draftText 的跨 tab 保持是 G3 引入的新能力，见 AC-3.1/3.2」。把「等价」限定到已保存值，新行为单列。

### SF-4 [F/事实] AC-2.4 modifier 组合泄漏示例与编辑器实际数据流不符

**问题**: AC-2.4「modifier 组合（alt+x / ctrl+shift+arrow）在编辑器内不泄漏可见字符」。

编辑器 `handleEditorInput` 的 printable 分支：`for (const c of cleaned) if (c >= " ") editorText += c`。`alt+x` 的终端序列通常是 `\x1bx`（ESC + x），`cleaned` 先 replace bracketed paste 标记（不匹配 `\x1b[200~`），然后 `c >= " "` 过滤掉 `\x1b`（< 空格），但 `x` 会被追加。

所以现状 `alt+x` **确实泄漏 `x`**（这是 bug 本身）。AC-2.4 描述正确，但修复路径取决于 MF-2：若用 pi-tui `parseKey`，`\x1bx` 会被解析为 `alt+x` keyId → 命中 special/modified → no-op，不进 printable 分支。若自建 parse，要自己识别 `\x1b` 前缀。

这条本身不是 must_fix，但它的可执行性依赖 MF-2 的方案决策。

**建议**: AC-2.4 补「修复后 parseKey(data) 对 alt+x 返回 "alt+x" keyId，编辑器路由命中 modified-key 分支 no-op，不进 printable 追加」作为可验证机制描述。

---

## nit

### N-1 [K] UC-3 主流程步骤 2「freeform 模式下方向键被 no-op，用户需 Esc 先退出编辑器」与 G1 修复后行为耦合

这句把 G1 的 no-op 行为作为 UC-3 的前置假设。逻辑上没问题，但 UC-3 是「跨问题草稿保持」用例，混入方向键语义会让用例边界模糊。建议把这句移到 UC-3 的「约束/备注」而非主流程步骤。

### N-2 [K] 数据清单「敏感级别」列对 draftText 标「用户输入（低）」

draftText 可能含用户粘贴的敏感内容（密码、token）。标「低」略乐观。建议标「用户输入（中）」或加注「可能含粘贴敏感内容，随 component 生命周期销毁」。

### N-3 [F] §8「不做 bracketed paste 跨 chunk 拆分的完美处理（边角情况，记 TODO）」

现有测试 C-PASTE-7 已经覆盖「跨 chunk 抵达时每个 chunk 独立剥离」并断言通过。需求标 TODO 与测试通过状态轻微不一致——要么 TODO 已被简单 replace 解决（应更新 §8），要么 C-PASTE-7 覆盖的是简单场景、复杂场景仍 TODO（应注明 C-PASTE-7 不覆盖什么）。不影响推进，记录备查。

---

## 附：已确认无 gap 的视角

1. **角色用例完整**: Actor（终端用户）单一，UC-1~4 覆盖输入/特殊键/草稿/提示四条主路径，无遗漏角色。
2. **跨系统依赖**: §6 pi-tui 依赖声明准确（matchesKey/truncateToWidth/wrapTextWithAnsi/visibleWidth 均为 pi-tui 导出，已核对 `keys.d.ts` + 实际 import）。但应补 `parseKey`（见 MF-2）。
3. **G1.1/G1.2 目标可追溯**: G1.1 覆盖 special key、G1.2 覆盖 modifier，分别对应 AC-2.3/2.4，追溯链完整（清单内容问题见 MF-1，结构没问题）。
4. **D-001/D-003/D-004**: 无新证据推翻，维持 confirmed。
