---
verdict: pass
upstream: issues.md
downstream: execution-plan.md
backfed_from: []
---

# 非功能性设计 — swf-scripts-docs-adr（T3：预制脚本 + 文档/ADR）

> **refactor 模式（纯文档/脚本主题）** — T3 无新运行时代码，8 个 issue 全是文档/脚本/配置交付。
> 维度扫描中安全/性能/并发/可观测大面积不适用（无运行时），真正相关的是数据完整性（部分）、
> 稳定性（预制脚本错误处理）、兼容性、可维护性、一致性。后者三维是 T3 的主战场：
> ADR 可追溯链、AGENTS.md↔实际目录同步、extension-deps schema 校验、deprecated 双处标记。

## 分析矩阵

> 维度为行（T3 维度适用模式比 issue 模式更清晰），列为 8 个 issue。
> 标记：✅ 无风险 / ⚠️ 有风险已缓解 / — 不适用（理由见下方「不适用维度统一理由」）。

| 维度 | #1 预制脚本 | #2 ADR-030 | #3 ADR-026/029 | #4 skill | #5 coding-execute | #6 AGENTS.md | #7 ext-deps | #8 deprecated |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| 安全 | — | — | — | — | — | — | — | — |
| 数据完整性 | — | ✅ | ⚠️ | — | — | — | ✅ | ⚠️ |
| 性能/延迟 | — | — | — | — | — | — | — | — |
| 并发/线程安全 | — | — | — | — | — | — | — | — |
| 稳定性/容错 | ⚠️ | — | — | — | — | — | — | — |
| 兼容性 | ⚠️ | — | — | ⚠️ | ✅ | — | ⚠️ | ⚠️ |
| 可观测性 | — | — | — | — | — | — | — | — |
| 可维护性 | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ⚠️ |
| 一致性 | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ |

**统计**：72 格中 — 46（4 个全不适维度 × 8 + 散布）、✅ 4、⚠️ 22。散布的 14 个 — 格不展开（数据完整性对纯文档/skill 更新不适用——无状态变更；稳定性对 ADR/文档/配置不适用——无运行时容错面；兼容性对 ADR-030/026-029/AGENTS.md 不适用——内部文档无消费方版本契约）。

### 不适用维度统一理由（— 46 格，集中说明防重复）

- **安全（8 格全 —）**：T3 无外部输入处理、无新权限模型、无认证面。预制脚本是静态参考文本（用户复制后自行执行，执行期安全由用户运行时环境管，非 T3 交付物职责）；ADR/AGENTS.md/extension-deps 是内部文档与元数据，无用户输入注入路径。
- **性能/延迟（8 格全 —）**：T3 无运行时代码。预制脚本作为静态文件随 npm 分发，不参与 Pi 进程热路径；ADR/文档/配置更新是加载期/构建期静态资源，无吞吐/延迟/P99 指标可言。
- **并发/线程安全（8 格全 —）**：T3 无运行时并发。预制脚本内的 parallel()/Promise.allSettled 调用是**用户复制执行后**的运行时行为，其并发控制由 T2 已实现的 ConcurrencyPool（分层配额 maxConcurrent=6）承担，非 T3 文档/脚本交付引入的并发面。
- **可观测性（8 格全 —）**：T3 无运行时可观测需求。ADR/文档/配置不产出日志/指标/追踪；预制脚本的执行期可观测由 workflow 运行时（pending:unregister 事件、live-record TUI）覆盖（T2 已完成），脚本模板本身不内嵌观测逻辑。

---

## 详细分析（仅展开 ⚠️ 维度，✅ 写一行理由）

### Issue #1: 预制脚本 4 模板 — 方案 B（完整可用示例）

#### ⚠️ 稳定性/容错：脚本错误处理（workflow 失败不 crash）

**风险**: 预制脚本是参考模板，用户复制到 `.pi/workflows/` 后 `workflow run` 执行。若脚本无 try-catch，中间 workflow() 调用失败时脚本抛未捕获异常，导致 `workflow run` 命令 crash（而非返回结构化 error），违背 AgentResult 契约（error 不 crash）。
**影响范围**: 用户复制执行 4 模板时的错误路径体验；`workflow run` 命令的稳定性（UC-1~UC-4 异常流程）。
**缓解方案**: 方案 B 每脚本含 try-catch + 返回 `{ error: ... }` 对象（AC-1.3），与 T1 executeAndAwait 的 AgentResult.error 语义对齐。
**残余风险**: 无——错误处理是模板内置；lintScript 不强校验 try-catch，但 AC-1.3 人工审查覆盖。

#### ⚠️ 兼容性：package.json files 声明 + lintScript 通过

**风险**: (1) `examples/` 未声明在 package.json `files` 字段 → `npm pack` 后模板不随包分发 → 用户 `pi install` 后看不到模板（G1 目标落空）。(2) 脚本不符合 workflow-script-format 规范（bare IIFE / 缺 workflow 调用）→ lintScript 失败 → `workflow run` 拒绝执行。
**影响范围**: npm 分发完整性（AC-1.4）；用户执行链（AC-1.2）。
**缓解方案**: package.json `files` 显式列 `examples/`（AC-1.4，机器校验 `npm pack --dry-run`）；4 脚本通过 lintScript（AC-1.2，机器校验）。
**残余风险**: 无。

#### ⚠️ 可维护性：注释说明分层配额 + $ARGS 入参

**风险**: 模板若无注释说明 workflow() 嵌套的分层配额规则（depth=N 时有效配额=max(1,6-N)），用户不知道深层嵌套会退化为串行，写出低效编排且不知为何慢。
**影响范围**: 用户基于模板二次开发的编排质量（UC-2 AC-2.3）。
**缓解方案**: 方案 B 注释说明分层配额规则 + $ARGS 入参语义（溯源 UC-2 AC-2.3）。
**残余风险**: 无。

#### ⚠️ 一致性：脚本格式符合 workflow-script-format + 并发上限与 T2 对齐

**风险**: 脚本若写死 parallel 上限 4（T2 前基线），与 T2 maxConcurrent=6 矛盾；脚本风格与 skill 文档示例不一致造成认知分裂。
**缓解方案**: 脚本 parallel() 调用不写死上限（并发由运行时 ConcurrencyPool 管），注释引向 skill 文档的 6；lintScript 保证格式一致。
**残余风险**: 无。

---

### Issue #2: ADR-030 合并架构决策记录 — 方案 A（单 ADR 全覆盖）

#### ✅ 数据完整性
ADR append-only 是项目既有约定（不可删除、Status 单调转换 Proposed→Accepted）。4 项核心决策已在 decisions.md D-030~D-033R 经 ask_user 确认，无未决不确定性，写入即定稿。非新风险。

#### ⚠️ 可维护性：ADR 可追溯性——引用 026/029 为前置

**风险**: ADR-030 若不显式引用 ADR-026/029 作为被 superseded 的前置决策，superseded 链断裂，未来维护者无法追溯"为什么从两包合并为一包"。
**影响范围**: 决策链可追溯性（UC-5 AC-5.3）。
**缓解方案**: ADR-030 Context/Decision 引用 ADR-026/029（AC-2.3）；并发上限标注来源 T2 system-architecture §并发池分层配额（AC-2.4 边界）。
**残余风险**: 无。

#### ⚠️ 一致性：ADR 格式合规（四节齐全）

**风险**: ADR-030 缺节（如漏 Consequences）→ 不符合项目 ADR 约定，AGENTS.md「docs/adr/ 已做出的决策，含 Status/Context/Decision/Consequences」约束失败。
**缓解方案**: 四节齐全（AC-2.1 人工审查）；Decision 含 4 项核心决策（合并/执行链/配额嵌套/删sync+通知）（AC-2.2 人工审查）。
**残余风险**: 无。

---

### Issue #3: ADR-026/029 superseded 标记 — 方案 A（Status 行 + 说明段）

#### ⚠️ 数据完整性：ADR-029 部分 superseded 精确性（D-033R 核心约束）

**风险**: ADR-029 若按 D-033 原决策**完全** superseded，会丢失"per-call cwd（决策1）+ 决策3(cw调用)/4(plan.json schema)/5(砍 pending-env)/6(store WAL) 仍有效且已实现"的可追溯性——这些决策在 types.ts:417/subagent-service.ts:302/pi-runner.ts:89 等处已实现且活跃（D-033R 架构 review 实证）。完全 superseded 会误导未来维护者认为整份 ADR 失效。
**影响范围**: ADR-029 六项决策的归属链完整性；未来维护者判断"哪些决策仍约束当前代码"。
**缓解方案**: ADR-029 Status="Partially superseded by ADR-030"（AC-3.2）；说明段逐决策标注被取代（决策2 worktree 编排）/仍有效（决策1 per-call cwd + 决策3 cw调用 + 决策4 plan.json schema + 决策5 砍 pending-env + 决策6 store WAL，均与合并正交）（AC-3.3 边界）。ADR-026 完全 superseded（AC-3.1，两包架构整体被合并取代）。
**残余风险**: 无——精确标注是机械操作，D-033R 已明确每项决策的归属。

#### ⚠️ 可维护性：保留原文 + 说明段（append-only）

**风险**: 若重写 ADR-026/029 内容（方案 B），历史决策原文丢失，无法追溯决策时的上下文与推理。
**缓解方案**: 方案 A 保留原文不动，只改 Status 行 + 顶部加 Superseded 说明段。遵循 ADR append-only 约定。
**残余风险**: 无。

#### ⚠️ 一致性：Status 行措辞统一

**风险**: Status 行措辞不一致（如 026 写 "Deprecated"、029 写 "Replaced"）→ superseded 标记语义混乱。
**缓解方案**: 统一用 "Superseded by ADR-030" / "Partially superseded by ADR-030" 措辞（AC-3.1/3.2 人工审查）。
**残余风险**: 无。

---

### Issue #4: workflow-script-format skill 更新

#### ⚠️ 兼容性：parallel() 上限 4→6 + skill 可加载性

**风险**: (1) skill 文档若仍写 parallel() 上限 4，与 T2 实现的 maxConcurrent=6 矛盾，用户按文档写 `parallel(...5项)` 困惑"文档说4但能跑5"。(2) SKILL.md frontmatter 若改坏（description 空/name 不匹配），workflow-generate 自动加载失败。
**影响范围**: skill 文档与运行时行为一致性（UC-9 AC-9.2）；skill 可加载性。
**缓解方案**: parallel() 上限改 6（AC-4.2）；本次只改正文（加 workflow() 章节），不动 frontmatter（name/description 已合规）；skill 加载由 resources_discover 保证。
**残余风险**: 无。

#### ⚠️ 可维护性：skill 与 examples/ 分工（D-031）

**风险**: 若 skill 文档也写完整脚本（与 examples/ 重复），两处维护负担且易分歧；若 examples/ 也只写 API 用法，失去完整编排模式参考价值。
**缓解方案**: D-031 确认分工——skill 示例简洁面 API 用法（AC-4.3），examples/ 完整面编排模式。
**残余风险**: 无。

#### ⚠️ 一致性：并发上限 6 来源标注

**风险**: skill 文档的 6 与 T2 system-architecture §并发池分层配额的 6 不同步，未来改 T2 上限时 skill 遗漏。
**缓解方案**: AC-4.2 改 6，并在 skill 文档注明来源 T2 system-architecture §并发池分层配额。
**残余风险**: 无。

---

### Issue #5: coding-execute skill worktree 编排更新

#### ⚠️ 可维护性：worktree 编排知识转移（不丢失）

**风险**: ADR-029 部分 superseded 后，worktree 编排（决策2：4 phase + git worktree add/remove）知识若只留在被标记 superseded 的 ADR 里，coding-execute skill 用户不知道这套编排模式，知识"沉淀在归档文档中无人查阅"。
**影响范围**: coding-execute skill 用户对 worktree 编排的理解（UC-11 AC-11.1）。
**缓解方案**: 内容来源 ADR-029 决策2 原文，转移到 coding-execute SKILL.md（AC-5.1/5.2）；D-033R 明确要求转移。
**残余风险**: 无。

#### ⚠️ 一致性：转移内容与 ADR-029 原文一致

**风险**: 转移时若改写内容，与 ADR-029 决策2 原文不一致，造成 ADR 与 skill 两处描述分歧。
**缓解方案**: AC-5.2 断言内容来自 ADR-029 决策2 原文（人工审查比对）。
**残余风险**: 无。

---

### Issue #6: AGENTS.md/CLAUDE.md 目录更新

#### ⚠️ 可维护性：目录与实际 extensions/ 一致

**风险**: AGENTS.md 目录树/包清单表若漏 subagents-workflow 条目或未标旧包 deprecated，AI 和人类按过时目录定位文件失败。项目 CLAUDE.md 强约束：「新增/删除/重命名 extension 后必须同步更新 CLAUDE.md 目录结构，防止 AI 因目录信息过时而定位失败」。
**影响范围**: 项目导航准确性；AI agent 的文件定位成功率。
**缓解方案**: 目录树 + 包清单表新增 subagents-workflow 条目（AC-6.1/6.2）；旧包条目标注 deprecated。
**残余风险**: 无。

#### ⚠️ 一致性：AGENTS.md ↔ 实际目录（check-structure 机器校验）

**风险**: AGENTS.md 写了 subagents-workflow 但实际目录不存在（或反之），check-structure gate 失败阻断提交。
**缓解方案**: AC-6.3 `bash .githooks/check-structure` 机器校验兜底（CLAUDE.md 同步检查）。
**残余风险**: 无。

---

### Issue #7: extension-dependencies.json 更新含依赖迁移

#### ✅ 数据完整性 / 可维护性
JSON 元数据更新，ajv schema 校验保证合法性；声明完整后可维护性自然满足。风险归兼容性/一致性维度。

#### ⚠️ 兼容性：coding-workflow dependsOn 迁移（pi-workflow → 新包）

**风险**: coding-workflow 的 `pi.__workflowRun` 硬依赖现在在新包（T1 已迁移实现）。若 extension-dependencies.json 仍声明 coding-workflow dependsOn `@zhushanwen/pi-workflow`（旧），依赖声明与实际运行时消费不符——用户按 extension-deps 装了 pi-workflow 但实际需要 pi-subagents-workflow，运行时 `pi.__workflowRun` undefined，coding-workflow 的 CW 执行链断裂。
**影响范围**: coding-workflow 运行时可用性；依赖声明的真实性（UC-8 AC-8.2）。
**缓解方案**: coding-workflow dependsOn 从 `@zhushanwen/pi-workflow` 迁移到 `@zhushanwen/pi-subagents-workflow`（AC-7.2）；旧两包条目保留但注明 superseded（UC-8 AC-8.4）。
**残余风险**: 无——迁移是声明层机械操作，ajv 校验 + 全量 typecheck 兜底。

#### ⚠️ 一致性：schema 校验 + 依赖同步

**风险**: extension-deps 不符合 schema（如 dependsOn 缺字段/类型错）→ ajv 失败；superseded 标注格式不统一。
**缓解方案**: `npx ajv-cli validate -s extension-dependencies.schema.json -d extension-dependencies.json`（AC-7.3 机器校验）；新增条目格式对齐既有条目（AC-7.1）。
**残余风险**: 无。

---

### Issue #8: 旧包 deprecated + CHANGELOG

#### ⚠️ 数据完整性：deprecated 字段发布后不可撤销

**风险**: `deprecated` 字段一旦 `npm publish`，该版本号在 npm 注册表上**永久**标记 deprecated（无法撤销该版本的 deprecated 标记，只能发新版本）。
**影响范围**: npm 注册表上的旧两包状态。
**缓解方案**: 发布前 `npm publish --dry-run` 验证 package.json deprecated 字段正确性（人工预验），CI 发布后 `npm info` 回验。
**残余风险**: 低——dry-run 验证后发布风险极低；接受。
**回灌指针**: → execution-plan T10.1 (jq deprecated 字段校验)；CI 发布后 `npm info` 回验属残余风险监控

#### ⚠️ 兼容性：旧包向后兼容 + deprecated 消息迁移路径

**风险**: deprecated 标记后 `npm install` 旧包显示 deprecation warning。D-004 锁定旧包不动代码，保证已安装用户功能不变（向后兼容）；但 deprecated 消息若不含迁移路径，用户不知道该装什么替代。
**影响范围**: 已安装旧包用户的迁移体验（UC-10 AC-10.2）。
**缓解方案**: D-004 不动旧包代码（行为等价，向后兼容）；deprecated 消息含迁移路径 `"Use @zhushanwen/pi-subagents-workflow instead"`（AC-8.2）。
**残余风险**: 无。

#### ⚠️ 可维护性：CHANGELOG 迁移指引完整性

**风险**: CHANGELOG 若只写 "deprecated" 不写迁移步骤，用户无法自行迁移。
**缓解方案**: CHANGELOG 记录 deprecated 版本号 + 迁移路径（卸载旧两包 → 装新包 → 功能等价）（AC-8.3）。
**残余风险**: 无。

#### ⚠️ 一致性：deprecated 双处标记（package.json + CHANGELOG）

**风险**: 只在 package.json 标 deprecated 但 CHANGELOG 不记录（或反之），两处不一致，用户查不同来源得到不同信号。
**缓解方案**: package.json `deprecated` 字段 + CHANGELOG 迁移说明双处标记（AC-8.1/8.3）。
**残余风险**: 无。

---

## 缓解项回灌登记（Mitigation Rollback）

> 纯文档/脚本主题：验收方式为「机器校验」（lintScript / ajv-cli / check-structure / npm pack --dry-run）
> 或「人工审查」（ADR 四节 / 内容正确性 / 迁移路径完整性）。回灌去向 = execution-plan（mid-detail 下游）。

| 缓解项 | 来源 Issue# | 维度 | 回灌去向 | 落地为 | 验收方式 | 状态 |
|--------|------------|------|---------|--------|----------|------|
| 4 脚本通过 lintScript + package.json files 含 examples/ | #1 | 兼容 | execution-plan | AC-1.2 / AC-1.4 | 骨架约束 | 待落 |
| 每脚本 try-catch 错误处理 + 分层配额注释 | #1 | 稳定/可维护 | execution-plan | AC-1.3 + 溯源 UC-2 AC-2.3 | 运维项 | 待落 |
| ADR-030 四节齐全 + 4 项决策 + 引用 026/029 + 并发来源 | #2 | 可维护/一致 | execution-plan | AC-2.1~2.4 | 运维项 | 待落 |
| ADR-026 完全 / ADR-029 部分 superseded + 逐决策标注 | #3 | 数据/一致 | execution-plan | AC-3.1~3.3 | 运维项 | 待落 |
| skill workflow() 文档 + parallel 上限 6 + 基础示例 | #4 | 兼容/一致 | execution-plan | AC-4.1~4.3 | 运维项 | 待落 |
| coding-execute worktree 编排转移（内容来自 ADR-029 决策2） | #5 | 可维护/一致 | execution-plan | AC-5.1 / AC-5.2 | 运维项 | 待落 |
| AGENTS.md 目录树 + 包清单表新增新包 | #6 | 可维护 | execution-plan | AC-6.1 / AC-6.2 | 骨架约束 | 待落 |
| check-structure gate 通过（AGENTS.md↔实际目录同步） | #6 | 一致 | execution-plan | AC-6.3 | 骨架约束 | 待落 |
| extension-deps 新条目 + coding-workflow dependsOn 迁移 | #7 | 兼容 | execution-plan | AC-7.1 / AC-7.2 | 骨架约束 | 待落 |
| ajv-cli validate 通过（schema 合法） | #7 | 一致 | execution-plan | AC-7.3 | 骨架约束 | 待落 |
| 旧包 package.json deprecated 字段正确性 | #8 | 数据 | execution-plan | AC-8.1（jq 校验） | 骨架约束 | 待落 |
| deprecated 消息迁移路径 + CHANGELOG 迁移指引 | #8 | 兼容/可维护 | execution-plan | AC-8.2 / AC-8.3 | 运维项 | 待落 |

---

## 残余风险登记

| 风险 | 影响 | 接受理由 | 监控方式 |
|------|------|---------|---------|
| 旧包 deprecated 版本 npm 标记不可撤销（来源 #8） | npm 注册表旧两包永久 deprecated 标记 | `npm publish --dry-run` 预验证 package.json 正确性后发布，风险极低；即便标记有误也可发新版本修正 | CI 发布后 `npm info` 回验 |
| 新旧包并存 tool/command 注册冲突（承接 T1 残余风险 R） | 升级窗口期内仍装旧两包的用户撞 `subagent`/`workflow` tool 重复注册 | D-004 锁定旧包不动；T3 CHANGELOG 迁移指引明确告知「装新包前卸载旧两包」——此为文档职责，非代码可解 | 用户反馈 / npm deprecated 消息引导 |

---

## 需⑤骨架验证的副作用

> T3 是纯文档/脚本主题（refactor 模式），无新运行时代码，无⑤骨架。
> 预制脚本的运行时行为（并发/错误传播）由 T1/T2 已实现的运行时代码承担，其骨架验证已在 T1/T2 NFR 完成。
> 本节无登记项。
