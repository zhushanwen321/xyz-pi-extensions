# Retrospect — subagent-streaming-a-c

## 概述
将 subagent text_delta streaming PoC 代码转为正式实现。PoC 已在前序会话验证通过（88 delta → 4 帧，setWidget 帧到达 RPC stdout），本 topic 做正式化：清理标记、补测试、文档化设计决策。

## 做得好的

### 1. PoC 验证先行
在正式化之前先做了完整的 PoC 验证（实际启动 pi RPC 模式触发 subagent），确认 setWidget 通道可用。这避免了在一个未验证的假设上堆代码。PoC 验证发现：
- 88 个 text_delta 合并为 4 个 setWidget 帧（22:1 合并比）
- leading/trailing edge 时序正确（首帧 "W" → 完整 haiku → 标点修正 → 终态清除）
- 主 session 不受影响（237 thinking + 198 text 正常流动）

### 2. 架构 review 驱动的正式化
前序会话做了 improve-codebase-architecture review，发现 5 个候选。候选 1-3 在 PoC 阶段已解决（SubagentStream 生命周期对象）。本 topic 处理候选 4（StreamSink 接口决策）和候选 5（双通道设计文档化），形成完整闭环。

### 3. 代码审查发现了真实边界 bug
subagent 审查发现空 delta 消耗 leading edge 的边界问题——`onDelta("")` 会把 `hasFlushed` 置 true，导致后续真实首个文本被延迟 100ms。修复极小（`if (delta.length === 0) return`），但如果没有审查这个 bug 会潜伏到生产。

## 做得不好的

### 1. subagent-service.ts 行数管理
文件在 cde92de1a 后是 998 行，W1+W3 注释加了 11 行导致超 1000 上限。被迫反复压缩注释——candidate 5 的设计说明从 9 行压到 3 行，丢失了部分根因解释（onEvent 耦合 onUpdate 的详细机制）。**长期问题**：这个文件需要拆分，999 行是在走钢丝。

### 2. W1+W3 共享 commit
W1（清理 [PoC]）和 W3（候选 5 注释）改了相同文件的相邻区域，无法用 `git add -p` 干净分拆，最终合并为一个 commit。CW 报了 `extraCommitReuse` warning。这不影响正确性，但失去了 Wave 级 commit 隔离的验证价值。

### 3. testCase expected 格式不匹配
首次提交 test 结果时 5/7 case fail——不是代码问题，是 actual.text 的引号格式与 expected.text 不匹配（`[Hello]` vs `['Hello']`）+ case 数量描述不同（10 vs 6）。CW 做精确字符串匹配，expected 设得太死板。后续要么在 plan 阶段用更宽松的 expected，要么接受这种格式敏感性。

## 关键决策记录

### StreamSink 接口保留（候选 4）
PoC 阶段标注为 `[hypothetical seam]`。正式化决策：**保留接口**。原因：
1. 语义显式——StreamSink 表达「UI sink 契约」
2. 测试 mock 友好（createMockSink 实现接口）
3. 移除 `[hypothetical seam]` 标注——PoC 已验证，单一 adapter 是确认的设计而非临时妥协

### 双通道设计文档化（候选 5）
不拆耦 onEvent/onUpdate（风险太大，影响整个节流逻辑），而是用注释明确记录设计选择：
- background 路径：stream 通道（onEvent=undefined）
- workflow 路径：onEvent 通道（stream=undefined）
- 根因：onEvent 耦合 onUpdate + 事件透传
- follow-up：长期拆耦后可统一为子通道

## 数据
- commits: 4（26dbc538e, eb374e079, 05702b1fd + PoC 基础 cde92de1a）
- 文件改动: 5（4 源文件 + 1 测试文件）
- 测试: 10 cases（plan 6 + review 补 2 + dispose 子例 2），全量 876 passed
- 行数: subagent-service.ts 999（上限边缘）
- PoC 验证: 88 delta → 4 帧（22:1 合并比）

## 后续
- **push 到远程**：PoC 提交（52bc84577, cde92de1a）+ 正式化提交（26dbc538e, eb374e079, 05702b1fd）共 5 个 commit 尚未推送
- **xyz-agent 侧实现**：另开 topic，设计文档已在 `/tmp/xyz-agent-subagent-streaming-4W6bNL/`
- **路径 C（fs.watch JSONL）**：作为终态/重连恢复的补充，未来增量
- **subagent-service.ts 拆分**：999 行需要按职责拆分（执行编排 / 记录管理 / 通知）
