---
phase: spec
verdict: pass
absorbed: false
topic: "2026-06-09-workflow-cc-compat-v2"
harness_issues:
  - "Review-Gate 停滞机制过于激进：3 轮 must_fix 未递减即判定 stagnation，但 review subagent 的 AC 检查阈值可能本身偏高。建议 stagnation 阈值改为 4-5 轮，或在 stagnation 后允许手动重置 review 计数。"
  - "Gate 检查旧 review 文件状态而非重新触发 review：修复 spec 后旧 review 文件（verdict=fail）仍存在，gate 直接读旧文件判定 fail。需手动删除旧 review 文件才能触发重新 review。建议 gate 在检测到 spec 修改时间 > 最新 review 修改时间时自动清除旧 review。"
---

# Phase 1 Retrospect: Spec

## 1. Phase Execution Review

### Summary

完成了 Pi workflow 扩展与 Claude Code 的全面对标分析，产出 spec.md 定义 3 个 FR（10 项功能需求 + 12 条 AC）：

- **FR-1 Structured Output 可靠性 (P0)**：schema 注入从 prompt 拼接改为 `--append-system-prompt` 临时文件注入，增加失败重试和盲区检测
- **FR-2 CC 格式兼容 (P1)**：phases 联合类型、args 别名、phase 传递、parallel/pipeline 签名扩展、budget 动态函数
- **FR-3 TUI 三层展示 (P2)**：延后到下一阶段，技术方案已验证并写入 spec 尾部供参考

关键调研产出：从 Claude Code 日志提取了完整提示词（81 个工具描述、3 个系统消息），保存到 `docs/research/claude-code-prompts/`。验证了 Pi CLI `--append-system-prompt` 支持、TUI `ctx.ui.custom()` 键盘交互能力、子进程扩展加载机制。

### Problems Encountered

1. **Review-Gate 停滞**：spec 最初缺少 2 个 AC（FR-2.3 显式 phase、FR-2.6 budget），review subagent 连续 3 轮 fail 后 gate 判定 stagnation。根因：review 第 1 轮就指出了问题，但 auto-mode 的 coding-workflow 扩展未将 review 反馈传回给我——我看到的是 gate 最终汇总结果而非中间 review 内容。修复方式是手动读 review 文件、补 AC、删旧 review 重跑。

2. **重复 workflow 目录**：brainstorming 阶段在 `.xyz-harness/2026-06-09-workflow-cc-compat/` 手动创建了 spec，但 coding-workflow-init 又创建了 `2026-06-09-workflow-cc-compat-v2/`。需要手动 cp spec 到新目录。

### What Would You Do Differently

- 不要在 coding-workflow-init 之前手动创建 spec 目录。先用 init 创建 workspace，再写 spec。
- brainstorming 对话和 coding-workflow 的衔接需要更清晰：对话中产出的设计文档应直接写入 workflow workspace 目录。

### Key Risks for Later Phases

- **FR-1.1 临时文件写入路径**：spec 假设 orchestrator 持有 `sessionDir`，但 `buildArgs()` 在 `AgentPool` 中调用，`AgentPool` 不持有 `sessionDir`。plan 阶段需明确跨组件传参方式。
- **FR-2.5 pipeline 笛卡尔积**：当前 `pipeline()` 在 worker-script 中是字符串拼接的代码，增加签名重载需要谨慎处理向后兼容。
- **FR-2.6 budget parentPort 消息**：worker-script 已有 `parentPort.on("message")` 监听，但 budget-update 消息需要主线程在 orchestrator 层推送，改动物理位置较远。

## 2. Harness Usability Review

### Flow Friction

- **brainstorming → coding-workflow 衔接断裂**：brainstorming skill 要求"在对话中逐步推进设计"，coding-workflow 要求"通过 coding-workflow-init 初始化 workspace"。两者没有自动衔接机制，导致设计产出和 workspace 产出分离。

### Gate Quality

- Review subagent 质量高：3 轮 review 始终聚焦同一 2 个 MUST_FIX，未漂移到无关问题。SHOULD_FIX 建议也合理（UC-3 标注延后、pipeline 增加 AC、重试终态明确）。
- Gate 的 stagnation 检测过于敏感：3 轮相同 must_fix 并不一定代表停滞——可能是 spec 未被修改（auto-mode 未传回 review 反馈）。

### Automation Gaps

- **Review 反馈未自动回流**：gate 触发 review subagent 后，review 结果（MUST_FIX 列表）没有自动传递给主 agent。主 agent 只看到 gate 最终的 FAIL 汇总，无法定位具体问题。需要手动读 review 文件。

### Time Sinks

- 删除旧 review 文件 + 重新 gate 占了 ~3 个交互轮次。如果 gate 能检测 spec 修改时间并自动 invalidate 旧 review，这部分可以省掉。
