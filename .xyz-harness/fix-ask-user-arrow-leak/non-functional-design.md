---
verdict: pass
upstream: issues.md
downstream: code-architecture.md
backfed_from: []
---

# 非功能性设计 — ask-user 键码泄漏修复 + 路由重构

## 分析矩阵

| Issue | 方案 | 安全 | 数据 | 性能 | 并发 | 稳定性 | 兼容性 | 可观测 |
|-------|------|------|------|------|------|--------|--------|--------|
| #1 parseKey 编辑器拦截 | 方案A（SDK 复用） | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ |

> **#1 数据维度说明**：矩阵中标 ✅（无风险）。#1 的安全维度 ⚠️ 已覆盖「draftText 敏感内容」风险，数据维度本身无额外风险（无持久化/无跨表事务）。
| #2 draftText 归位迁移 | 方案A（分流预填） | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ✅ |
| #3 handleInput 拆分 | 方案A（抽 handleOptionsInput） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #4 编辑器提示行 | 方案A（dim help 行） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| #5 键码回归测试套件 | 方案A（完整套件） | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

（✅ 无风险 / ⚠️ 有风险已缓解 / ❌ 不可接受需回退 / — 不适用+理由）

> 维度定性说明（全局，避免逐条重复）：
> - **数据（全部 ✅）**：ask-user 是进程内 TUI 组件，无数据库、无持久化、无跨表事务。所有状态（含新增 `QuestionState.draftText`）随 component 生命周期销毁，不存在数据一致性问题。
> - **并发（全部 ✅）**：单 session TUI 交互，同步事件循环，`handleInput` 单调用栈串行执行，无多线程/多实例并发。`_resolved` 终态守卫（BC-6，保持不动）已覆盖 FR-12 重入竞态——同一 component 的 submit/cancel 后所有输入 no-op，多次 Enter 不会重复触发结果。
> - **可观测（全部 ✅）**：TUI 组件无结构化日志/metrics/tracing 需求，不存在可观测性维度。`renderCall`/`renderResult` 是 UI 可见输出，不纳入可观测分析。

## 详细分析

### Issue #1: SDK parseKey 编辑器拦截 — 方案 A（SDK 复用）

#### ⚠️ 安全影响

**风险**: `draftText` 可接收用户粘贴的敏感内容（密码/token/凭证）。这些内容是即时输入数据，不持久化（随 component 销毁），但通过 import SDK `parseKey` 新增了一条从原始字节流到编辑器 buffer 的解析路径，需确认解析层不会把敏感字节流泄漏到非预期位置（如异常信息、渲染输出、component 级残留字段）。
**影响范围**: `handleEditorInput` 的 printable 提取分支（draftText 追加）+ `renderQuestionView` 渲染输出。
**缓解方案**:
1. printable 提取分支保留现有 `c >= " "` 控制字符过滤（BC-3 保持），控制字节不进 draftText。
2. parseKey 命中 special（返回非 undefined）时直接 no-op return（除单字符 ASCII printable code 32-126 外，parseKey 返回该字符本身正常追加；空格特判：parseKey(" ")="space" 需显式追加空格）——敏感字节流若是特殊键码形态（如 `\x1b[C`）被整体丢弃，不逐字符泄漏。
3. 渲染输出只读 `state.draftText`（#2 迁移后），无 component 级单实例残留（#2 AC-2.5 反模式检查兜底）。
**残余风险**: draftText 内容会渲染到终端（这是编辑器本职，非泄漏）。接受理由：编辑器就是用来显示用户输入的，masked-input 不在本次范围（requirements §8 Out of Scope 未列但属未来 feature）。

#### ✅ 性能影响

`parseKey(data)` 在每次按键的 `handleEditorInput` 入口调用（频次 = 用户打字速度，人类极限 ~10 键/秒）。parseKey 是纯函数字符串匹配，无 IO/无分配大对象/无正则回溯灾难，单次成本 < 微秒级。human typing 远低于框架刷新阈值，无性能风险。

#### ⚠️ 稳定性影响

**风险**: `parseKey` 返回 `undefined` 时的 printable 提取分支是否健壮？两个隐患点：
1. **bracketed paste 序列**（`\x1b[200~`/`\x1b[201~`）parseKey 返回 undefined（非已知 special key），随后靠 `data.replace(...)` 剥离。若 SDK 未来某版本把 bracketed paste 标记识别为 special key，parseKey 返回非 undefined → 进入 no-op 拦截分支 → 粘贴内容被整体丢弃（BC-1 退化）。
2. **多字符粘贴 chunk**（含 emoji/多字节）parseKey 返回 undefined，靠 `for (const c of cleaned)` 按 code point 迭代。若 chunk 内混入控制字符，`c >= " "` 过滤兜底。
**影响范围**: `handleEditorInput` printable 提取分支（UC-1 粘贴场景）。
**缓解方案**:
1. 依赖关系明确：parseKey 先判 special（BC-7 方向键拦截），undefined 才进 printable 提取（BC-1/BC-2/BC-3 保持）。两层正交，parseKey 不消费字节，printable 提取不依赖 parseKey 命中集合——即使 parseKey 行为变化，printable 提取逻辑自洽。
2. 现有 C-PASTE-1~7 测试（180 测试中的粘贴套件）+ #5 新增 C-ARROW/C-KEYMAP 套件双重回归，覆盖「special 拦截」与「printable 追加」两条路径。
3. parseKey 对 bare printable 单字符（如按 `a`）的返回行为需确认：若返回 `"a"`（非 undefined），则 single-char printable 也走 parseKey 分支，printable 提取分支只在多字符 chunk 时触发。需在 #5 测试中显式断言单字符输入仍正确追加（C-PASTE-1 保持绿）。
**残余风险**: SDK parseKey 未来版本若改变 bracketed paste / bare printable 的返回语义，粘贴行为可能退化。接受理由：SDK 是稳定公共 API（system-architecture §8 契约稳定性=稳定），180 测试 + C-PASTE 套件提供回归防线，退化会在测试期暴露而非生产。

#### ⚠️ 兼容性影响

**风险**: 依赖 SDK `parseKey` 的返回语义稳定（keyId 字符串格式 vs undefined 边界）。两个兼容契约：
1. **keyId 格式**：`"up"`/`"alt+x"`/`"ctrl+shift+right"` 等字符串。ask-user 侧用 `matchesKey(keyId, "escape"|"enter"|"backspace")` 判定编辑器语义键——若 SDK 改 keyId 命名（如 `"esc"` 而非 `"escape"`），matchesKey 命中失效，编辑器退化为 all-no-op。
2. **undefined 语义**：parseKey 返回 undefined = 「不可识别的多字符序列」。若 SDK 把某些当前返回 undefined 的序列改为返回 keyId，这些序列从「printable 追加」变成「no-op 拦截」，粘贴行为改变。
**影响范围**: `handleEditorInput` 路由判定 + `matchesKey` 调用。
**缓解方案**:
1. parseKey 与 matchesKey 同源（均 `@mariozechner/pi-tui`），keyId 格式由同一模块定义，parseKey 产出的 keyId 必然能被 matchesKey 消费——不存在跨模块命名漂移。
2. AC-1.3（no-op 集合遍历）、AC-1.4（modifier 矩阵 18 用例）、AC-1.5（C-PASTE 回归）三套测试锁定 parseKey 的当前行为，SDK 升级时这些测试是契约验证点。
3. CLAUDE.md「导航键用 matchesKey 识别」规范（项目级硬约束）已强制走 SDK，不存在「自建解析 + SDK 混用」的兼容分裂。
**残余风险**: 无。parseKey/matchesKey 同源 + 测试锁定 + 项目规范三重保障，兼容性风险已闭合到测试期。

### Issue #2: draftText 归位迁移 — 方案 A（分流预填）

#### ✅ 安全影响

迁移不改变数据流向，draftText 内容与原 editorText 完全一致（同一字节流，换持有者）。安全态势不变——敏感内容仍是即时输入、不持久化、随 component 销毁。

#### ✅ 性能影响

字段访问从 `this.editorText`（实例字段）改为 `state.draftText`（对象属性），两者都是 O(1) 属性读取，无性能差异。跨文件参数链（component → question-view）参数传递成本可忽略。

#### ✅ 稳定性影响

迁移是纯 refactor，行为严格等价（D-2 分流预填保持 BC-4/BC-4b/BC-4c/BC-5）。不变式从「组件级 editorText 进入编辑器时重赋值」变成「state.draftText 进入编辑器时重赋值」——归属更清晰，不变式相同，稳定性不降反升（消除组件级单实例的隐式状态）。

#### ⚠️ 兼容性影响

**风险**: `QuestionState` 新增 `draftText: string` 字段。两个兼容点：
1. **createQuestionState() 初始化**：新字段必须初始化 `draftText: ""`，否则 undefined 传播到渲染层导致 `buildEditorBlock` 拼接 `undefined` 字符串。
2. **渲染层参数链**：question-view.ts 的 `renderQuestionView`/`buildOptionLines`/`buildSplitPane`/`buildEditorBlock` 参数名可保留 `editorText`（从 `state.draftText` 传入），但需确认所有调用点都传 `state.draftText` 而非残留 `this.editorText`。
**影响范围**: types.ts（QuestionState 定义）+ component.ts（所有 editorText 引用）+ question-view.ts（参数链）。
**缓解方案**:
1. AC-2.5 反模式检查：`grep "private editorText\|this\.editorText" component.ts` 无输出，机器兜底确保无残留。
2. AC-2.1/AC-2.2（draftText 跨 tab 保持/独立）+ AC-2.3/AC-2.4（BC-4b/BC-4c 回归）覆盖预填逻辑正确性。
3. `createQuestionState()` 加 `draftText: ""` 是 TypeScript 强类型约束（字段非可选），tsc gate 兜底——未初始化会编译失败。
**残余风险**: 无。强类型 + grep + 测试三重兜底，兼容性风险闭合。

### Issue #3: handleInput 拆分 — 方案 A（抽 handleOptionsInput）

#### 全部维度 ✅

- **安全/数据/性能**：纯代码移动，无逻辑变更，无新数据流，无性能影响。
- **并发/稳定性**：单 session 同步调用栈，拆分不改变调用时序。options 分支逻辑原样搬迁，行为等价（AC-3.2 现有 180 测试全绿兜底）。
- **兼容性/可观测**：内部方法重组，无外部契约变化，无可观测性维度。
- 行数约束（AC-3.1：handleInput ≤ 40 行）是 CLAUDE.md 规范遵守，不是风险。

### Issue #4: 编辑器提示行 — 方案 A（dim help 行）

#### 全部维度 ✅

- **安全/数据/并发/稳定性**：纯渲染层文本追加，无状态变更，无新数据流，无并发，无故障路径。
- **性能**：help 行是静态字符串，每次 render 固定成本，无计算开销。
- **兼容性**：复用现有 help 行位置（freeform 已有 `Enter submit · Esc back`，comment 同理），扩展文案不破坏现有渲染契约。
- **可观测**：无。

### Issue #5: 键码回归测试套件 — 方案 A（完整套件）

#### 全部维度 ✅

- **安全/数据/并发/稳定性**：测试代码不引入运行时风险。
- **性能**：测试套件运行时间可忽略（~30 新增用例，纯字符串断言）。
- **兼容性**：测试不改变生产行为，只验证。
- **可观测**：测试本身是可观测性的实现（回归防线）。
- 本 issue 是 #1~#4 所有缓解项的验收载体。

## 缓解项回灌登记（Mitigation Rollback）

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|----------|------|
| printable 提取保留 `c >= " "` 控制字符过滤（BC-3） | #1 | 安全 | ⑤test-matrix | C-PASTE-1~7 回归（现有套件保持绿） | 代码测试 | 待落 |
| parseKey 命中 special 时 no-op return，不逐字符泄漏 | #1 | 安全 | ⑤test-matrix | C-ARROW-1/2（方向键夹输入断言） | 代码测试 | 待落 |
| no-op 集合遍历断言 editorText 不变 | #1 | 兼容性 | ⑤test-matrix | AC-1.3（C-KEYMAP-*） | 代码测试 | 待落 |
| modifier 组合矩阵（18 用例）不泄漏可见字符 | #1 | 兼容性 | ⑤test-matrix | AC-1.4（C-KEYMAP-MOD） | 代码测试 | 待落 |
| 单字符 printable 输入仍正确追加（parseKey 行为确认） | #1 | 稳定性 | ⑤test-matrix | C-PASTE-5（单字符输入）保持绿 | 代码测试 | 待落 |
| 单字符空格输入追加（parseKey space 特判） | #1 | 稳定性 | ⑤test-matrix | C-KEYMAP-SPACE（单字符空格追加） | 代码测试 | 待落 |
| bracketed paste 剥离 + code point 迭代（BC-1/BC-2）保持 | #1 | 稳定性 | ⑤test-matrix | C-PASTE-2~7 保持绿 | 代码测试 | 待落 |
| QuestionState.draftText 初始化 `""`（防 undefined 传播） | #2 | 兼容性 | ⑤骨架约束 | types.ts createQuestionState() 强类型字段 | 骨架约束 | 待落 |
| 反模式检查：component.ts 无 `this.editorText` 残留 | #2 | 兼容性 | ⑤test-matrix | AC-2.5（grep 无输出） | 代码测试 | 待落 |
| 分流预填：freeform/comment 入口独立预填（禁 fallback 链） | #2 | 稳定性 | ⑤test-matrix | AC-2.1/2.2（C-DRAFT-1/2）+ AC-2.4（C-BC4C） | 代码测试 | 待落 |
| handleInput ≤ 40 行纯路由 | #3 | 稳定性 | ⑤test-matrix | AC-3.1（sed 行数统计） | 代码测试 | 待落 |

> **验收方式分布说明**：本主题无「性能混沌」项（无 SLA 目标、无吞吐/延迟量化需求——TUI 单用户交互）；无「运维项」（无部署/监控配置）。所有缓解项集中在「代码测试」（实现层行为可断言）和「骨架约束」（强类型字段存在性由 tsc gate 兜底）。
>
> **「代码测试」项判定依据**：每条都是代码行为（拦截/过滤/初始化/预填/行数），可写明确通过/失败断言（editorText === "ab" / grep 无输出 / 测试全绿），满足「实现层不确定性 + 可断言」双标准。

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| SDK parseKey 未来版本改变 bracketed paste / bare printable 返回语义 | 粘贴行为退化（内容被 no-op 丢弃）；单字符返回行为已实测确认（code-arch §1 keys.js:1093-1096）并由 C-PASTE-5 回归锁定 | SDK 是稳定公共 API（§8 契约=稳定）；C-PASTE-1~7 + C-ARROW 套件提供回归防线，退化在测试期暴露 | 依赖 #5 测试套件作为 SDK 升级时的契约验证点 |
| draftText 渲染敏感内容到终端（密码/token 明文） | 敏感内容在终端 scrollback 可见 | 编辑器本职就是显示用户输入；masked-input 是独立未来 feature（不在本次范围） | 无（接受现状，未来 feature 处理） |

## 需⑤骨架验证的副作用

无。本主题无高不确定性副作用需骨架验证：
- parseKey 返回语义已在 #5 测试套件中通过 C-ARROW/C-KEYMAP/C-PASTE 直接验证（非「理论分析有分歧」的并发/缓存场景）。
- draftText 迁移是纯 refactor，行为等价由 D-2 分流预填决策 + 现有测试兜底，无「补偿逻辑复杂」的并发/一致性场景。
- handleInput 拆分是纯移动，无新逻辑需验证调用链。

5 个 issue 的实现路径已在 issues.md 定稿，code-arch 阶段直接据此产出 code-skeleton + test-matrix，无需回写本节。
