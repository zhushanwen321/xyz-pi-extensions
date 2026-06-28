---
frame: 编排结构审计（execution）
round: 1
---

# 追踪 Round 1 — 编排结构审计（execution）

> fresh-context subagent 审计（Group A）。主读 execution-plan.md，交叉验证 code-architecture.md §4/§9 + issues.md + decisions.md。

## 审计结论
- **切片独立性**：PASS（Wave 1 为编译基石先行特例，设计原则 2 自洽说明；各 Wave 均有测试入口）
- **依赖闭合**：发现 4 gap（1 笔误 + 1 标注缺口 + 1 文件影响遗漏 + 1 多余依赖）
- **并行安全**：PASS（Wave 2/3/5 并行组内各子切片改不同文件，无同文件冲突；record-store.ts 被 Wave 1+3B 共改但串行）

核心结构（Wave 1 基石 → Wave 2 叶子 → Wave 3 分流 → Wave 4 汇合 → Wave 5 外壳 → Wave 6 验收）依赖方向正确，blocked_by 与 issues.md 在 #6/#7/#12/#13 关键汇合点闭合。

## 发现的 gap

### K-Gap-1: Wave 2D（WTM.scan）对 2A（alive-store）的 import 依赖未标注 [CROSS-VALIDATED]
- 类型: K（认知缺口）
- 位置: execution-plan.md Wave 2D「Subagent 配置」+ 调度表 Wave 2 Blocked by
- 问题: WTM.scan 在代码层 import alive-store（readAliveMarker + isProcessAlive，D-024 安全网）。证据：code-architecture.md §9 line 796（WTM.scan「接线 alive+gitRun」）+ issues.md #4 blocked_by 含 #13。但 Wave 2D 的 Subagent 配置「读取文件」仅列 session-runner.ts:233 先例，未提 alive-store；调度表 Wave 2 整体 Blocked by 仅写「Wave 1」。对比 2E 明确标注了 import #13 依赖——2D 没标注，不对称。
- 建议修法: Wave 2D 读取文件补 `2A alive-store`，照搬 2E 措辞补注 import #13 导出须在 2A 就绪后；调度表/并行约束声明 2D/2E 均 blocked_by 2A。

### F-Gap-1: mermaid DAG 节点 W5c 标签误写「Wave 5D」
- 类型: F（笔误）
- 位置: execution-plan.md line 44 依赖 DAG 图
- 问题: `W5c[Wave 5D: ADR-001 修订 #11]`——节点 ID 是 W5c，标签文字写「Wave 5D」。全计划只存在 5A/5B/5C（调度表 5C ADR），不存在 5D。
- 建议修法: 标签改为 `Wave 5C: ADR-001 修订 #11`。

### F-Gap-2: Wave 1 文件影响集遗漏 record-store.ts（STATUS_PRIORITY 加 crashed）[CROSS-VALIDATED]
- 类型: F（文件影响集不完整）
- 位置: execution-plan.md Wave 1「文件影响」vs 调度表（含 STATUS_PRIORITY）/ SubagentConfig 读取文件（含 record-store.ts STATUS_PRIORITY）
- 问题: Wave 1 调度表声明含「STATUS_PRIORITY 加 crashed key」（#2 AC-2.1），STATUS_PRIORITY 物理位置 record-store.ts:24（code-architecture.md §9 line 792）。但 Wave 1「文件影响」仅列 types.ts/execution-record.ts/path-encoding.ts，未列 record-store.ts 为修改目标。SubagentConfig「读取文件」又列了 record-store.ts——即要读它改 STATUS_PRIORITY 但「文件影响」漏登。
- 建议修法: Wave 1 文件影响补 `修改: record-store.ts（STATUS_PRIORITY 加 crashed key，#2 AC-2.1）`。

### K-Gap-2: Wave 5B「依赖 GC #10」声明与 issues.md #9 不一致
- 类型: K（多余依赖）
- 位置: 调度表 + mermaid DAG `W2e --> W5b`
- 问题: 调度表 5B 写「依赖 #4 + GC #10」，mermaid 画 `W2e --> W5b`。但 issues.md #9 blocked_by = #1,#4,#7（不含 #10）。index→gc 是现有依赖（#10 仅扩展 walkAndClean 清理范围不改签名），5B 改动（挂 scan+缓存）不依赖 #10 扩展。把现有 index→gc 调用误当 5B→#10 新依赖。
- 建议修法: 调度表 5B 说明删「+ GC #10」；mermaid 删 `W2e --> W5b` 边。

## 维度通过声明
- [x] 每 Wave 垂直切片可独立验证（Wave 1 编译基石特例自洽）
- [x] 依赖从⑤§4 时序图推导（有调用证据；2D→2A 一条漏标 K-Gap-1，5B→#10 一条多余 K-Gap-2）
- [x] 同并行组不改同一文件（record-store.ts 被 Wave 1+3B 共改但串行，F-Gap-2 漏登使去重声明打折扣）
