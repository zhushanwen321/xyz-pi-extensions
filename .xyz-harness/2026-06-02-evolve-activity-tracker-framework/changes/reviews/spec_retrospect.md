---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-02-evolve-activity-tracker-framework"
harness_issues:
  - "subagent dispatch 因 API key 配置失败，被迫降级为主 agent 直接执行 review，失去独立审查的上下文隔离优势"
  - "brainstorming skill 的 Step 1-4（提问→方案→设计→用户确认）在 compact 后的续接场景中无法严格按序执行——设计已在 compact 前完成，skill 加载后直接跳到 Step 5+6"
---

# Spec Phase Retrospect — activity-tracker-framework

## 1. Phase Execution Review

### Summary

从 skill-state（384 行）提取通用 Activity Tracker 框架，内置到 evolve-daily 中。12 项 FR 覆盖完整生命周期，7 项 AC 可测试。核心设计决策：`createTracker(config)` 工厂函数 + 声明式 TrackerConfig + 共享状态机（loaded → completed | error → recorded）。

关键决策：
- 工厂函数模式（非类继承）— 384 行中约 70% 是通用样板，只有 triggerMatch/steering 是 skill-specific
- Anchor 机制（triggerType/triggerTurn/triggerSummary）— 使 L3 Python extractor 能定位 JSONL 原始上下文
- Sample 机制 — issue 附带叙事级上下文片段，解决 L4 LLM "只知道指标不知道发生了什么" 的问题

### Problems Encountered

1. **git pull 冲突（main 分支新增 pi-extension-standards.md）**：merge 后 CLAUDE.md 和 standards.md 有大量新增规范。用户要求审查 spec 是否符合新规范，发现 3 个 MUST_FIX。这是正面事件——spec 质量因此提升。

2. **subagent dispatch 失败**：review subagent 因 "No API key found for opencode" 启动失败。降级为主 agent 直接执行 review，功能上等价但失去了独立审查的上下文隔离。

3. **brainstorming skill 步骤跳跃**：设计讨论在 compact 前已完成（Step 1-4），skill 加载后从 Step 5（Assumption Audit）续接。这符合 skill 的 Phase Loop 机制，但实际执行中 Step 1-4 的 checklist 项全部标记为已完成需要手动追溯。

### What Would You Do Differently

- **先 pull 再写 spec**：如果一开始就 `git pull origin main` 拿到最新的 pi-extension-standards.md，3 个 MUST_FIX 可以在初版就避免（尤其是 renderCall/renderResult 和闭包调用位置）。
- **review 不依赖 subagent**：当前环境 subagent 配置不稳定，review 直接由主 agent 执行更可靠。独立审查的价值在于"不同视角"，但 subagent 反复失败的成本更高。

### Key Risks for Later Phases

1. **向后兼容 deserializeState 是高风险区**：旧 `"skill-state-tracker"` entry 格式需要精确映射，plan 阶段必须明确旧格式的字段列表
2. **index.ts 合并复杂度**：evolve-daily 的 index.ts 已有 detector 注册逻辑，新增 tracker 注册可能使文件超过 500 行（标准 §18.2 反模式上限）
3. **tracker.py 的 JSONL entry 字段映射**：L3 extractor 需要知道 tracker entry 的完整字段结构，plan 阶段需明确

## 2. Harness Usability Review

### Flow Friction

- **brainstorming skill 对续接场景支持不够**：skill 的 checklist 假设从 Step 1 开始的线性流程。compact 后续接时，已完成步骤需要手动标记，增加了认知负担。建议 skill 增加"resume from step N"的快速路径。
- **gate check 脚本路径不稳定**：`xyz-harness-gate` 从 `packages/evolve-daily/skills/` 迁移到 `packages/coding-workflow/skills/` 后，路径变了两次。建议统一到一个确定位置或在 CLAUDE.md 中记录当前路径。

### Gate Quality

- **4 项检查全部 PASS，无 false positive**：spec.md verdict=pass、review verdict=pass、must_fix=0、untracked files=0。Gate 正确识别了所有必要条件。

### Prompt Clarity

- **pi-extension-standards.md 对 spec 审查非常有价值**：本次审查中 8 项标准检查直接来自该文件。建议 brainstorming skill 的 Step 6（Write spec）增加一个子步骤："read docs/pi-extension-standards.md，逐项检查 spec 是否合规"。

### Automation Gaps

- **spec 审查可以半自动化**：pi-extension-standards.md 中的 [规范] 条款可以提取为 checklist 脚本，自动扫描 spec.md 是否覆盖了关键字段（renderCall/renderResult、闭包约束、error handling）。当前全靠人工比对。
- **MUST_FIX 修复后的 re-verify**：修复后需要手动 grep 确认。如果有 pre-commit hook 检查 spec 合规性，可以自动捕获。

### Time Sinks

- **subagent 失败 + 重试 + 降级**：整个过程消耗了约 3-4 分钟（等待超时 + 诊断 + 手动执行）。如果环境配置正确，subagent dispatch 应该是秒级的。
