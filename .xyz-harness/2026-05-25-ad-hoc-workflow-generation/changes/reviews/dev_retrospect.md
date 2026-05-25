---
phase: dev
verdict: pass
---

# Phase 3 (Dev) 复盘 — Ad-hoc Workflow Generation

## Phase 执行质量

### 总结

4 Task、3 Wave 按计划执行。简单路径（主 agent 直接编码），2 次 commit，code review 发现 3 条 MUST_FIX 全部修复后 v2 通过 gate。总耗时 7 turns。

### 遇到的问题

1. **accessSync 误用（MF1）**：saveWorkflow 用 `accessSync` + try/catch 判断文件存在，权限错误会被静默吞掉。正确做法是直接用 `existsSync`。这是在写代码时"聪明"地复用了已有 import，没有选最合适的 API。

2. **去重过滤静默丢弃 unavailable workflows（MF2）**：加了 `if (wf.available)` 过滤，导致加载失败的脚本从列表中消失，用户无法诊断。原始代码（改之前）没有这个过滤，是我在重构去重逻辑时错误地加上的。教训：重构时保持原有行为，不要"顺手优化"。

3. **FR6 面板增强遗漏（MF3）**：plan 中 Task 4 标注了"widget: [tmp]/[saved] 标签 + 面板操作增强"，但实现时我把所有 panel 逻辑都放在了 commands.ts 的 /workflows handler 中，widget.ts 实际零改动。这不是错误（commands.ts 的 /workflows 注册也在那），但说明 plan 和实际实现路径有偏差。review 正确指出 FR6 未实现。

4. **import 来回修改**：accessSync、CachedWorkflowMeta、WorkflowSource 等 import 反复添加又删除，浪费了 2-3 个 turn。原因是写代码时先加了"可能用到"的 import，后续 lint 报错才删。

### 下次的不同做法

- 文件存在性判断统一用 `existsSync`，不要用 accessSync + try/catch 模式
- 重构时保持原行为不变，"过滤"和"去重"是不同操作，不要混在一起
- 先写完代码再跑 lint，避免来回修 import（先写逻辑，最后统一整理 import）
- Plan 中标注了某个文件要改但实际上逻辑在另一个文件中时，在 self-check 阶段就应该发现

### 关键风险

- **commands.ts 已接近 500 行**：save + 路由 + 面板 + 共用函数都在一个文件中。后续如果继续增加子命令，需要拆分
- **deleteWorkflow 的 isRunning 回调**：通过函数参数传入运行状态检查，耦合度可接受但不够优雅

## Harness 体验

### 流程摩擦

- **Code review 3 条 MUST_FIX 全部有效**：无一条是误报，修复都很直接。review 质量高。
- **v1 → v2 循环效率高**：3 条修复 + 1 次 commit，不需要重新理解上下文

### Gate 质量

- Gate 正确识别 v2 review 的 verdict=pass
- 自动检测 test_results.md 和 code_review 文件的存在性

### 自动化缺口

- **Unused import 自动修复**：eslint --fix 可以自动删除 unused import，不需要手动来回
- **existsSync vs accessSync 模式检查**：可以加一条 taste-lint 规则：禁止用 accessSync 判断文件存在
