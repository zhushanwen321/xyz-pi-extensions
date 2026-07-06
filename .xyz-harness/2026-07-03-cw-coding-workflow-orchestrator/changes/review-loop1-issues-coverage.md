---
reviewer: review-fix-loop route-1（issues 覆盖重建）
cognitive-frame: 反向（他证）
source: system-architecture.md（独立重建）+ requirements.md（补充）
forbidden: 未读 issues.md 全文前完成重建
---

# Review-Loop Round 1 — issues 覆盖重建 diff

## 重建方法论

从 system-architecture.md 按 4 轴独立扫可拆元素 → 推导候选 issue 集合（30 项，R1-R30），**再**读 issues.md 上游覆盖核验表做 diff。重建时未读 issues.md 正文。

## 重建候选集合（节选，按轴）

- **状态§4**: R1 转换表组织 / R2 跨阶段级联 / R3 渐进式进入态判定（首次有效提交触发流转）
- **模块§3**: R4 CwStore DAO+事务 / R5 schema 演进 / R6 gate 注册表 / R7 plan-parser / R8 入参约定 5 子项 / R9 内化迁移 / R10 lib/gates / R11 types.ts 迁入 / R12 index.ts 重构
- **边界§6**: R13 child_process 豁免 / R14 GitValidator 失败语义 / R15 review 桩契约 / R16 node:sqlite experimental 风险
- **挑战§5+§7+§9+§13**: R17 gateTier 4 档 / R18 多 checker fail-fast / R19 丢 claimedStatus / R20 dev commit 三项校验 / R21 mid test commitHash 语义 / R22 gateHistory 完整 / R23 内化 5 步 / R24 删 coding-execute.js / R25 check_execute.py 并存 / R26 GateRunner 错误处理 / R27 nextAction / R28 渐进入参 / R29 skill 收口批次 / R30 coverage tier 分化

## Diff 结论

**PHANTOM**：无。#1-#11 + #12-#14 每条均能在 system-architecture（或 decisions.md）找到依据。

**MISSING + MISMATCH**：见下分级。

---

## MUST_FIX（2 项，严重，阻塞 MVP 验收或核心路径）

### M1 [MISMATCH + MISSING] §10 skill 收口改造批次归 #7，但 #7 只覆盖 review 落盘子项

- **位置**: issues.md 上游覆盖表 `| §10 skill 收口改造批次（D-007-REVISIT）| 兜底 | #7 | ✅ 已覆盖 |`
- **事实**: system-architecture §10 含 4 个子项——① §10.1 新增入口 skill `coding-workflow`；② §10.2 description 映射句；③ §10.2 review 落盘；④ §10.2 JSON 产出步骤（+ §12.1 明确"skill 产 JSON 归 skill 收口改造，与 review 落盘同批"）。#7 描述仅讲"review 桩跨 skill 契约保障"，AC-7.1/7.2 只覆盖 review 文件存在性。子项 ①②④ 无任何 issue 承接。
- **额外错配**: 上游覆盖表 `| §12 JSON schema 3 套 | 挑战 | #5 | ✅ |` —— #5 是 CW 侧 plan-parser 解析校验，**不覆盖** skill 侧 JSON 产出改造（§12.1 明确归 skill 收口）。§12 同时跨 CW 解析（#5 ✅）与 skill 产出（无 issue），表只标了一侧。
- **影响**: ① 入口 skill `coding-workflow` 是 requirements G2 的 MVP 验收项（"agent 工具箱中只有 coding-workflow tool" + "新增入口 skill coding-workflow"）。无 issue = 无实施规划 = MVP 验收风险。② JSON 产出缺失则 CW 解析链路断裂（D-006 可行性前提）。
- **建议**: 新增 P1 issue「skill 收口改造批次（入口 skill + description 映射 + JSON 产出 + review 落盘）」作为 #7 的上位 issue，或扩展 #7 scope 显式列入 4 子项。同时修正上游覆盖表 §12 一行，拆为"CW 解析侧（#5）/ skill 产出侧（新 issue）"。

### M2 [MISSING] coding-execute skill 改造无 issue 承接

- **位置**: issues.md 上游覆盖表 `| §13 删 coding-execute.js workflow 脚本 | 挑战 | — | N/A | 已定删除，无方案空间 |` 与 `| §13 保留 check_execute.py | 挑战 | — | N/A |`
- **事实**: §13.1 删 workflow 脚本是定了，但同段明确"其原承载的 **Wave 派发 + worktree 隔离 + test-runner 落盘**逻辑由 CW + coding-execute skill + agent 协作重建"。§13.2 又定"需注意 test-results.json 与 cw test 的 cases 数组**数据来源一致**"。这两项是有方案空间的 skill 改造（coding-execute skill 内部如何从"调 workflow 脚本"改为"指导 agent 用 subagent 派发 Wave" + 数据契约对齐），不是"已定无方案空间"。N/A 标注误判。
- **影响**: dev/test 是核心执行路径。coding-execute skill 改造无规划 → execution 期发现 skill 与 CW dev/test action 契约对不齐 → 阻塞。
- **建议**: 新增 P1 issue「coding-execute skill 适配 CW（Wave 派发指导改 + test-results.json ↔ cw test cases 契约对齐）」。修正上游覆盖表 §13 两行的 N/A 理由（脚本删除本身无方案空间，但 skill 重建有方案空间）。

---

## SHOULD_FIX（4 项，建议）

### S1 [MISMATCH] §3 action 入参约定（5 子项）归 #10，#10 只覆盖数组统一

- **位置**: 上游覆盖表 `| §3 action 入参约定（topicId/不订阅 pi.on/throw/dependsOn/workspacePath）| 模块 | #10 | ✅ |`
- **事实**: #10 描述仅讲"dev/test 入参数组（D-005 长 1/N）handler 内部统一循环"。5 子项中只覆盖"数组统一"（dependsOn 的数组语义），topicId 定位 / 不订阅 pi.on / throw 错误返回 / workspacePath 语义 4 子项虽在 §3 已写死（无方案空间），但声称 #10 覆盖不准确。
- **建议**: 改标 N/A（4 子项已定无方案空间），或 #10 scope 显式纳入。当前归属误导读者以为 #10 实现了这 4 个约定。

### S2 [MISSING] §6 child_process 运行时约束段未被上游覆盖表扫描

- **位置**: 上游覆盖表边界轴漏行。§6 明确"项目约束（CLAUDE.md）限制扩展用 child_process...CW 是第三个 child_process 用户...GateRunner spawn（pi-workflow 先例）/ GitValidator execFileSync（pi-subagents 先例）"。
- **事实**: 这是 CW 扩展在 CLAUDE.md 约束下合法使用 child_process 的合规点，是 #3（GitValidator）/ #6（GateRunner）的实施前提。间接被 #3/#6 覆盖，但表未显式扫描该段。
- **建议**: 补一行 `| §6 child_process 运行时约束（第三用户豁免）| 边界 | #3/#6 | ✅ | 实施前提，遵循 pi-workflow/pi-subagents 先例 |`，让合规点显式可追溯。

### S3 [MISMATCH] §5.2 mid test commitHash 语义归 #3，#3 只讲失败语义

- **位置**: 上游覆盖表 `| §7 不变式：dev/test commit 真实性 | 挑战 | #3 | ✅ |`；system-architecture §5.2 "mid test commitHash 语义：指向 dev 阶段产出的、被本次测试覆盖的 commit"。
- **事实**: #3 聚焦"失败容错（逐条 vs fail-fast）"，AC-3.1-3.4 只讲存在性三项校验 + 失败反馈。mid test commitHash 的"来源约束"（必须指向 dev 阶段已记录的 commit，不仅是存在性）在 #3 AC 未体现。requirements AC-4.3 有约束（"指向 dev 阶段的测试产物 commit 或同一批 commit"），但 #3 未带。
- **建议**: #3 AC 补一条"mid test commitHash 必须能在 _cw.db wave 表追溯到已 committed 的 dev commit"（否则 agent 可提交任意合法 commit 骗过 medium-coverage）。

### S4 [MISSING] §4.3 渐进式进入态判定（首次有效提交触发流转）无显式 AC

- **位置**: system-architecture §4.3"进入态：首次有效提交时流转到 developed/tested"。
- **事实**: "首次有效提交"的精确语义（commit 校验通过才算"有效"；首次触发 planned/detailed → developed 流转，后续不流转）是实施决策点。#2 guard 的 AC 只覆盖状态机线性 + 级联，未覆盖"首次有效"判定；#10 渐进入参也未带。
- **建议**: #2 AC 补一条"首次有效 dev/test 提交触发状态流转，后续渐进提交不流转只更新 _cw.db"。

---

## OK（验证通过）

- **#1-#11 + 迷雾 #14 + 延后 #12 + Won't #13**：每条均在 system-architecture（或 decisions.md）找到依据，无 PHANTOM。
- **N/A 项归类合理**：Pi SDK（零 Port 已定）/ lib/gates re-export 移除（已定）/ evidence 追溯（agent-mediated，§11 诚实标注）。
- **R5 schema 演进 → #11** ✅；**R16 node:sqlite experimental 风险** → D-016 已确认接受，#1 隐含覆盖（轻微，#1 AC 可补"experimental API 兼容性验证"）；**R30 coverage tier 分化** → §8 已定无方案空间（轻微）。
- **#7 review 桩本身的契约设计**（方案 A 预检 + hint，不造假 stub）✅ 验证通过——M1 不是质疑 #7 内容，而是 #7 的 scope 被上游覆盖表夸大。

---

## 一句话总结

发现 **2 个 MUST_FIX**（§10 skill 收口批次与 §13 coding-execute skill 改造两处 skill 侧工作无 issue 承接，前者直接影响 G2 MVP 验收项、后者影响 dev/test 核心路径）+ 4 个 SHOULD_FIX（覆盖表归属不准 / 漏扫 / AC 未带来源约束与首次有效语义），无 PHANTOM。
