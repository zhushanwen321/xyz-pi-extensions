---
phase: dev
verdict: pass
---

# Phase 3 (Dev) Retrospect — Infinite Context Engine

## Phase Execution Review

### Summary

从 plan.md 的 6 个 Task 出发，通过 subagent 串行编码（BG1→BG2），产出 1948 行 TypeScript（8 个模块文件 + 2 个入口文件）。3 轮 5 步专项审查（v1→v2→v3），MUST FIX 从 v1 的 avg 4.5 条收敛到 v3 的 0 条。

关键数据：
- 总代码行数: 1948（预估 1200，实际偏高因为 tree-compactor 的 subagent spawn 逻辑和 context-handler 的截断策略比预期复杂）
- subagent dispatch 次数: 6 编码 + 15 审查（5步×3轮）= 21 次
- MUST FIX 累计修复: ~20 条（v1: 4+6+4+2+5=21 → v2: 2+2+1+1+0=6 → v3: 0）
- commit 数: 8（6 编码 + 2 review 修复）

### Problems Encountered

1. **writeSegmentFile 是 no-op（功能阻断）**。Task 1 的 subagent 留下了空实现 `void ctx; void segment;`。Robustness v1 和 BLR v1 同时发现。根因: subagent 将"写入段文件"理解为"后续 Task 实现"而非"现在实现"。修复后还有回归——每次 turn_end 都覆盖文件导致只保留最后一个 turn 数据。v2 BLR 发现回归，改为只在段创建时写入。

2. **retention window 方向反了**。代码取 max（宽松），spec C-6 要求 min（严格）。segment-tracker 和 tree-compactor 各实现一遍且方向相同地错了。BLR v1 就发现，v2 仍未修（修复引入了新 bug），v3 才确认修复。根因: "更宽松/更严格"的自然语言注释与代码逻辑方向不一致。

3. **assembleMessages 只追加不替换**。集成审查发现摘要被 unshift 到原文前面，原始 messages 不减少。根因: 低估了 AgentMessage 结构复杂性（无 segId 字段），无法精确按段过滤。改为百分比截断策略（保留后 30%，前面替换为摘要）。

4. **shouldCompress 只看摘要 tokens**。自动压缩永远不会触发。根因: treeContextTokens 只计算摘要的几百 tokens，远低于 70% 阈值。修复为计算最终 messages 的总 tokens。

5. **session_before_compact 只在压缩中 cancel**。Pi 原生 compaction 可能在非压缩期间执行。根因: cancelPiCompaction() 设计为只在子进程运行时返回 cancel。修复为无条件返回 `{ cancel: true }`。

6. **subagent import scope 错误**。使用了 `@earendil-works/*` 而非 `@mariozechner/*`。Standards v1 和 Taste v1 同时发现。根因: subagent 参考了 Pi 内部源码的 import（用 @earendil-works），没遵守项目 CLAUDE.md 公约。

7. **工厂函数 130 行超限**。Standards v2 指出。根因: 4 个 handler + 2 个渲染器 + 注册全在一个函数内。提取为 6 个模块级命名函数后工厂函数缩至 18 行。

8. **硬编码 200k context window**。Integration v2 发现。非 200k 模型（如 128k）上会超限。修复为从 ctx.getContextUsage() 动态获取。

### What Would I Do Differently

- 对 subagent 的 task prompt 中，对"文件写入"类需求明确说"现在实现完整逻辑，不留 TODO 或空函数"
- 在写 assembleMessages 前，先画完整数据流图: 原始 messages → 识别保留窗口 → 截断 → 注入摘要 → 最终 messages
- 对 `min(A, B)` 类逻辑，注释中直接写代码表达式而非自然语言——"取 min" 比 "更宽松" 精确
- retention window 逻辑只实现一次（在 SegmentTracker 中），TreeCompactor 复用 tracker.getRetentionWindow()，避免同步修复两处
- subagent task prompt 中加 import scope 约束行: "所有 import 使用 @mariozechner/* scope，不用 @earendil-works/*"

### Key Risks for Later Phases

- **E2E 测试依赖真实 Pi 环境**: 压缩管线（自动触发 → subagent spawn → 校验 → 持久化 → context 替换）只能在真实 Pi 中验证。百分比截断策略的 30%/70% 分割是粗略估计
- **subagent prompt 质量未经验证**: LLM 输出树 JSON 的稳定性在 Phase 4 需要用实际样例测试
- **recall 工具的段文件路径**: 依赖 ctx.cwd/.pi/infinite-context/ 结构，如果 Pi 的 cwd 机制变化会失效

## Harness Usability Review

### Flow Friction

- **5 步专项审查效率高**: 并行 dispatch 4 个 reviewer（BLR + Standards + Taste + Robustness），每个独立迭代。比单步 review 发现更多问题——BLR 发现业务逻辑 bug，Integration 发现模块间数据流错误，两者互补
- **v1→v2→v3 迭代收敛速度可接受**: v1 avg 4.5 MF → v2 avg 1.2 MF → v3 0 MF。但每轮修复引入少量新问题（如 import typo、retention 方向修复不彻底），需要 3 轮才收敛
- **BLR 和 Integration 串联**: Integration review 消费 BLR 的模拟执行路径，发现了 BLR 未覆盖的跨模块问题（如 assembleMessages 只追加不替换）

### Gate Quality

- gate 准确检测了所有 review 文件的 YAML frontmatter 格式问题（must_fix 字段位置、verdict 值不匹配）
- 无 false positive。每次 FAIL 都指向具体的 review 文件和字段
- gate 不检查 review 内容质量——如果 reviewer 写了 verdict: pass 但实际有问题，gate 无法发现

### Time Sinks

- **review YAML 格式调试**: 每轮都有 1-2 个 review 文件的 YAML frontmatter 不符合 gate schema（must_fix 嵌套在 review 对象内而非顶层）。约占每轮 10% 时间
- **重复的 retention window 逻辑**: segment-tracker 和 tree-compactor 各实现一遍，修复需要同步。如果一开始就让 tree-compactor 复用 tracker.getRetentionWindow()，可以省去一轮修复
- **TypeScript 类型系统摩擦**: Pi 的 ExtensionHandler 类型重载导致 context handler 的类型推断多次失败，需要手动调整类型签名

### Automation Gaps

- **subagent 不感知 gate check 的 YAML schema**: 如果能自动注入 gate 的 frontmatter 要求到所有 review subagent 的 task prompt，可以避免格式不匹配
- **subagent 不感知项目 CLAUDE.md 的 import scope 约束**: 虽然会自动加载 CLAUDE.md，但模型可能忽略。需要在 task prompt 中显式重申关键约束
- **修复-审查循环缺乏自动化**: 每次 MUST FIX 修复后需要手动 dispatch v2/v3 review subagent。如果能自动检测"代码变更 → 重新 dispatch 受影响的 review"，可以减少手动编排
