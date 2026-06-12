---
verdict: pass
must_fix: 0
---

# Spec Review v2 — Pi Plan Mode Extension

## 评审记录

- 评审时间：2026-06-11
- 评审类型：Spec 评审（Mode 1: Plan review — 验证 spec 完整性）
- 评审对象：`.xyz-harness/2026-06-11-plan-mode/spec.md`
- 评审模式：增量审查（继承 v1 评审的 issue 列表）
- 前一轮评审：`changes/reviews/spec_review_v1.md`（verdict: pass, must_fix: 0）

## 总体评估

spec 整体结构完整：覆盖 plan mode 完整生命周期的 10 个功能区块（FR-1~FR-10）、11 条可验证的验收标准（AC-1~AC-11）、明确的约束清单和 4 个核心 use case。v1 评审已通过（0 must_fix），本轮作为 v2 重新独立评审：

1. **v1 7 项 issue 状态确认**：4 low + 3 info，全部 **仍为 open**（spec.md 在 v1 之后未修改）
2. **本轮新发现 6 项 issue**：全部 low（无新增 must_fix）
3. **核心需求表达完整**，可作为 Phase 2 (plan.md) 的输入

## v1 评审 issue 状态（增量继承）

| ID | 严重度 | 标题 | 状态 | v2 备注 |
|----|--------|------|------|---------|
| L1 | low | FR-5.6/5.7 的「与 coding-workflow 一致」表述不准确 | open | 仍未修复（spec.md:73-74, 140 仍用此表述） |
| L2 | low | 未声明可选运行时依赖 pi-ask-user / pi-subagents | open | 仍未修复（Constraints 段仍只列 Goal） |
| L3 | low | /plan status 子命令未在 spec 中显式声明 | open | 仍未修复（FR-1.4 仅描述「/plan 不带参数」行为） |
| L4 | low | FR-1.3 描述「已有 plan 文件」时未指定扫描路径 | open | 仍未修复（spec.md:22 与 24 之间缺乏路径声明） |
| I1 | info | FR-2.9 与 FR-3.5 之间的转换点不够明确 | open | — |
| I2 | info | UC 覆盖度低于设计文档 | open | — |
| I3 | info | FR-1.7 描述的 plan-mode 系统提示词内容未列出 | open | — |

**v1 评审的判定合理**：上述 7 项均为精确度/一致性改进项，未触及 spec 核心正确性，未阻塞 Phase 2。

## v2 新发现 issue

### N1: FR-1.6 与 FR-7.3 的状态生命周期边界模糊

- **位置**：`spec.md:24, 92`
- **严重度**：low
- **描述**：
  - FR-1.6 规定「进入时生成 plan 文件路径 `/tmp/plan-{slug}.md`」，但「生成路径」与「创建文件」的边界未明确：路径是仅在内存中保留（用户确认后创建文件），还是立即创建空文件？这会影响 `complete` / `abort` 时文件存在性的判断逻辑。
  - FR-7.3 规定「取消后 plan 文件保留在 /tmp 不管，状态清除」，但「状态清除」含义不清：是 `active = false` 即可，还是需要从 `sessionManager.entries` 物理删除 `plan-state` entry？影响 abort 后再次进入 plan mode 时是否能看到已取消 plan 的历史。
- **影响**：实现时出现两种解读，可能导致 abort 行为不一致。
- **建议**：FR-1.6 明确「仅记录路径 + 在 `select-template` 时创建文件」；FR-7.3 明确「active=false + 保留 plan-state entry 以供查询历史」。

### N2: AC 缺少 session_before_tree 路径的覆盖

- **位置**：`spec.md:127-128, AC-7/AC-8`
- **严重度**：low
- **描述**：AC-7/AC-8 仅覆盖 `complete` → compact 成功/失败两种路径，FR-5.4 描述的「tree 回退」路径（用户选 b）没有对应的 AC。FR-5.7 规定了 `session_before_tree` handler 的行为，但没有 AC 验证 handler 在 plan mode 活跃时是否正确注入摘要。
- **影响**：tree 路径的回归保护不足。Phase 2 编写 plan.md 时可能遗漏 tree handler 的测试规划。
- **建议**：补充 AC：「`complete` 后选择 tree 回退时，`session_before_tree` handler 在摘要中注入 plan 文件路径」。

### N3: handler 返回值签名未在 spec 中声明

- **位置**：`spec.md:73-74, FR-5.6/FR-5.7`
- **严重度**：low
- **描述**：FR-5.6/5.7 描述了两个 handler 的功能（自定义压缩摘要 / 注入 plan 文件路径），但没有声明 handler 的返回值签名。设计文档 5.7 给出了 `session_before_compact` 的返回结构 `{ compaction: { summary, firstKeptEntryId, tokensBefore } }`，spec 应当显式引用或独立声明这一签名约定，否则实现者可能误用。
- **影响**：实现时返回值结构不明确，可能与 Pi runtime 期望的签名不匹配。
- **建议**：在 FR-5.6/5.7 各加一句：「返回值遵循 Pi runtime 的 compaction 自定义格式（参见 [Pi docs 链接]）」。

### N4: FR-3.5「一次 turn 写完所有章节」与复杂场景的张力

- **位置**：`spec.md:48, FR-3.5`
- **严重度**：low
- **描述**：FR-3.5 规定「AI 一次 turn 写完所有章节，全部章节写完后才让用户确认」。但 research-plan 模板（设计文档 4.1）含 5 个章节，feature-plan 含 5 个章节——单次 turn 写完在 token 预算下基本可行，但研究类 plan 可能扩展到 8+ 章节，强制一次写完会导致：
  - 单次 turn 输出过长，模型在生成末尾章节时可能「忘记」前文约束
  - 失败时已写章节无法单独保存
- **影响**：复杂场景下 spec 约束过严，可能导致 plan 质量下降。
- **建议**：将 FR-3.5 软化为「尽量一次 turn 写完；当章节数 > 6 或预估 token > X 时允许分批」，或保留硬约束但补充失败回退机制（部分章节已写时 abort 不影响已写内容）。

### N5: FR-1.3「继续/实现/新建/取消」选项语义模糊

- **位置**：`spec.md:22, FR-1.3`
- **严重度**：low
- **描述**：FR-1.3 规定用户「不带描述的 `/plan`」时检测到已有 plan 文件后提示选择（继续/实现/新建/取消），但四个选项的具体含义未在 spec 中定义：
  - 「继续」= 读 plan 文件后直接进入 Phase C（writing）还是 Phase B（brainstorming）？
  - 「实现」= exit plan mode + 读取 plan + 启动 goal？还是仅 exit？
  - 「新建」= 覆盖旧 plan 文件（备份？）还是生成新 slug 的文件？
- **影响**：实现时不同选项的边界行为可能与用户预期不一致。
- **建议**：为每个选项在 FR-1.3 子项中明确动作（如 FR-1.3.1: 继续 = 读 plan → 跳到 writing 阶段；FR-1.3.2: 实现 = exit + 注入执行 steer）。

### N6: FR-2.7「假设审计」的边界模糊

- **位置**：`spec.md:43, FR-2.7`
- **严重度**：low
- **描述**：FR-2.7 要求「提取设计中对代码的假设，grep 验证接口/类型是否存在」。但「假设」的定义模糊：仅指 AI 在 brainstorming 阶段显式声明的「假设 X 文件存在 Y 接口」类陈述？还是任何对代码库的引用（包括 B3 方案中提到的函数/类型）？边界过宽会导致过度 grep，过窄会漏掉关键假设。
- **影响**：实操中 AI 可能执行不足（仅验证自己声明的）也可能执行过度（验证每个函数引用）。
- **建议**：在 FR-2.7 补充示例：「假设」指 B3 方案中所有引用的非标准库 API、自定义类型、扩展点（如 `ctx.compact`、`__goalInit`、`pi.sendUserMessage` 等），不包括标准库或编程语言内置。

## v2 整体统计

```
total_issues: 13
must_fix: 0
low: 10
info: 3
```

| 维度 | v1 | v2 (本轮) | 变化 |
|------|----|----------|------|
| must_fix | 0 | 0 | — |
| low | 4 | 10 | +6（本轮新发现） |
| info | 3 | 3 | — |
| 总体 verdict | pass | pass | 维持 |

## 跨轮次决议

- **不升级 v1 的 low issue 为 must_fix**：依据「LOW 分级收紧规则」，v1 的 4 项 low 属于「与本次需求核心目标无直接冲突的精确度改进」，且 spec 已通过其他 FR/AC 间接覆盖了对应行为（如 FR-9.1/9.2/9.3 覆盖了 L2 的依赖关系；FR-1.5/1.8 覆盖了 L3 的 status 场景）。升级为 must_fix 缺乏必要性。
- **不升级 v2 新发现的 6 项 low 为 must_fix**：所有 6 项均为「实现精度」或「边界明确性」问题，不影响 spec 驱动 Phase 2 (plan.md) 的能力。

## 关键正面观察（与 v1 一致）

- **AC 全部可验证**：AC-1~AC-11 没有「AI 应该……」类不可测试描述
- **状态管理清晰**：FR-9.1/9.2/9.3（sessionManager + appendEntry + session_start 重建）与项目 ADR-021 决策一致
- **只读约束设计正确**：FR-8.2 显式声明「仅通过提示词实现，不用 tool_call 拦截」与 ADR-020 一致
- **Goal API 引用正确**：FR-6.4 使用 `__goalInit`（验证 extensions/goal/src/index.ts:422 实际暴露此 API）
- **复杂度评估合理**：核心机制（compact、goal API、状态管理）均有现成实现可参考
- **AC 覆盖矩阵**：

| AC | FR 来源 | 覆盖状态 |
|----|---------|---------|
| AC-1 | FR-1.1/1.2/2.1~2.10 | ✅ |
| AC-2 | FR-2.4/2.5 | ✅ |
| AC-3 | FR-2.6 | ✅ |
| AC-4 | FR-3.3/3.5 | ✅ |
| AC-5 | FR-3.6 | ✅ |
| AC-6 | FR-7.1/7.2 | ✅ |
| AC-7 | FR-5.3/5.6 | ✅ |
| AC-8 | FR-5.8 | ✅ |
| AC-9 | FR-6.4 | ✅ |
| AC-10 | FR-4.1~4.4 | ✅ |
| AC-11 | FR-9.1~9.3 | ✅ |

## 结论

**Pass。** spec.md 满足 Phase 1 (Spec) 完整性要求：核心需求明确、范围合理、验收标准可量化、约束与项目 ADR 对齐。13 项 low/info 级 issue 均为精确度改进，不阻塞 Phase 2 (plan.md) 编写。

**建议**（不强制）：进入 Phase 2 前，开发人员可考虑：
1. 同步修复 v1 L1~L4（4 项 low，约 30 分钟工作量）
2. 在 Phase 2 plan.md 的 E2E 测试设计中补充 tree 路径的覆盖（N2）
3. 将 handler 返回值签名作为 Phase 2 的隐含约束（N3）

---

## 评审元数据

```yaml
review:
  type: spec_review
  round: 2
  timestamp: "2026-06-11T15:00:00"
  target: ".xyz-harness/2026-06-11-plan-mode/spec.md"
  previous_review: "changes/reviews/spec_review_v1.md"
  incremental: true
  summary: "spec 评审 v2 通过。继承 v1 的 4 low + 3 info issue（全部仍为 open，spec 未修改），本轮新增 6 项 low issue（实现精度问题，无 must_fix）。整体 verdict 维持 pass。"

statistics:
  total_issues: 13
  must_fix: 0
  must_fix_resolved: 0
  must_fix_inherited: 0
  low_inherited_open: 4
  low_new: 6
  info_open: 3

issues_inherited_from_v1:
  - id: L1
    status: open
    severity: low
  - id: L2
    status: open
    severity: low
  - id: L3
    status: open
    severity: low
  - id: L4
    status: open
    severity: low
  - id: I1
    status: open
    severity: info
  - id: I2
    status: open
    severity: info
  - id: I3
    status: open
    severity: info

issues_new_in_v2:
  - id: N1
    severity: low
    title: "FR-1.6 与 FR-7.3 的状态生命周期边界模糊"
  - id: N2
    severity: low
    title: "AC 缺少 session_before_tree 路径的覆盖"
  - id: N3
    severity: low
    title: "handler 返回值签名未在 spec 中声明"
  - id: N4
    severity: low
    title: "FR-3.5「一次 turn 写完所有章节」与复杂场景的张力"
  - id: N5
    severity: low
    title: "FR-1.3「继续/实现/新建/取消」选项语义模糊"
  - id: N6
    severity: low
    title: "FR-2.7「假设审计」的边界模糊"
```
