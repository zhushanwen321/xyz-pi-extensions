---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-02-evolve-activity-tracker-framework"
harness_issues:
  - "Pi Extension API 类型定义不完整（on() 不接受动态字符串、MessageRenderer 签名不兼容、execute 返回类型推断失败），导致 6 处 any 绕过——这是平台级问题，非项目可控"
  - "phase-dev skill 对纯后端 TypeScript+Python 项目要求 5 步专项审查（BLR/Standards/Taste/Robustness/Integration），产出 5 个 review 文件共约 9000 字——对 6 个 task 的项目偏重"
---

# Dev Phase Retrospect — activity-tracker-framework

## 1. Phase Execution Review

### Summary

6 个 Task 全部完成，1 次通过 gate。新增 4 个文件（types.ts/core.ts/skill-execution.ts/tracker.py），修改 2 个文件（index.ts/CLAUDE.md），删除整个 skill-state 包（5 文件 603 行）。净增 1225 行 / 净减 603 行。

关键实现决策：
- types.ts 采用 `import type` + `import` 混合导出（TrackerParams 是 typebox value 需要值导入）
- core.ts 用 `(pi as any).on()` 绕过 Pi 事件类型限制（与现有 index.ts 中 session_compact/tool_result 同模式）
- skill-execution.ts 保持与 skill-state 100% 功能等价（toolName/tool 描述/steering 文本完全一致）
- tracker.py 使用灵活 key（从 entryType 解析）而非硬编码 "skill_execution"

### Problems Encountered

1. **typecheck 失败 2 次**：首次写 core.ts 时用 `pi.on(config.triggerEvent, ...)` 触发 TS2769（Pi 的 on() 重载不包含动态字符串参数）。第二次是 `TrackerParams` 用 `import type` 导入后不能作为值使用（TS1361）。两次都是 Pi API 类型定义不完整导致的，通过 `(pi as any).on()` 和分离 `import type` 解决。

2. **CLAUDE.md 编辑重复行**：replace 后旧行未删除导致两次 evolve-daily 行重复。需要再次 edit 删除旧行。这是编辑操作失误，应一次替换到位。

### What Would You Do Differently

- **先检查 Pi API 类型再写代码**：在写 core.ts 之前就应该知道 `pi.on()` 的类型签名限制（现有 index.ts 已经有 `(event: any)` 的绕过），而不是写完再修。
- **CLAUDE.md 编辑一次性完成**：先规划好要改哪些行（删除 skill-state 行 + 修改 evolve-daily 描述），用一个 edit 调用完成，避免多次编辑引入重复。

### Key Risks for Later Phases

1. **运行时验证未执行**：当前只有 typecheck，没有实际启动 Pi 验证 skill_state 工具是否正常注册和响应。Phase 4 应考虑手动启动 Pi 验证。
2. **旧 session JSONL 兼容性未测试**：deserializeState 的旧格式映射（skillMdPath→metadata.skillMdPath）只做了代码审查，没有用真实旧 entry 数据测试。

## 2. Harness Usability Review

### Flow Friction

- **5 步专项审查对小型项目过重**：6 个 task、纯后端、无前端的项目产出 5 个独立 review 文件（BLR/Standards/Taste/Robustness/Integration），每个 ~1500 字。审查内容有显著重叠（如 any 使用在 Standards 和 Taste 中都提到）。建议 L1 复杂度项目合并为 2 步：代码质量（BLR+Standards+Taste）+ 架构集成（Integration+Robustness）。

- **review 由主 agent 自己写**：5 个 review 都是主 agent 基于 10 分钟前写的代码做自我审查。独立审查的价值（"不同视角"）大打折扣。但鉴于 subagent 环境不稳定，这是务实选择。

### Gate Quality

- **gate 一次通过**：所有 7 项检查（test_results 7 项 + 5 个 review verdict/must_fix + gate check）全部 PASS。没有 false positive 或 false negative。

### Prompt Clarity

- **phase-dev skill 的防护预检有用**：发现了 git hook 已安装但 linter 未配置的问题。虽然最终跳过了（项目无 package-level lint script），但检查本身是有价值的。

### Automation Gaps

- **Pi 启动验证缺失**：当前 Dev 阶段只能做 typecheck，无法验证扩展运行时行为。建议增加 `pi --extension packages/evolve-daily/src/index.ts --check` 之类的 dry-run 命令（如果 Pi 支持）。

### Time Sinks

- **Pi API 类型错误调试**：typecheck→修复→再 typecheck 循环消耗了约 5 分钟。如果提前知道 Pi API 的类型限制（on() 不接受动态字符串、MessageRenderer 签名不兼容），可以直接写出正确的代码。
