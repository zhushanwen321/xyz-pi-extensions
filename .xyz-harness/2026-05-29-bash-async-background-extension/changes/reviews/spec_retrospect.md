---
phase: spec
verdict: pass
---

# Spec Phase Retrospect — bash-async-background-extension

## Phase Execution Review

### Summary

完成了 bash-async 扩展的 spec 设计，覆盖 4 种执行模式（sync+detach / background / poll / kill）、17 条 AC、12 条 FR。关键决策：

1. **覆盖内置 bash 而非新建工具名**（ADR-010）— 减少AI认知负担
2. **使用 `child_process.spawn` 直接管理而非 `BashOperations.exec()`** — review v1 发现根本性的 API 冲突（BashOperations timeout 会 kill 进程，与 detach 需求不兼容）

用户中途离开（"我睡觉去了，不要询问我"），剩余步骤（兼容性分析、spec 修改、review 分发）全部自主完成。

### Problems Encountered

1. **API 选型错误（严重）**：初版 spec 基于 `BashOperations.exec()` + `createLocalBashOperations()` 设计。review v1 发现三个根因相同的致命问题：
   - BashOperations timeout 会 kill 进程，与 detach 语义冲突
   - `getShellConfig`/`getShellEnv` 不是公开 API
   - Background 模式无法从阻塞的 exec() 立即返回
   - **修复**：全面重写 FR-1，改用 `child_process.spawn` 直接管理 + 自行实现 shell 发现

2. **内置 bash 兼容性分析不足**：初版未深入分析内置 bash 的全部能力（`trackDetachedChildPid`、`waitForChildProcess`、`shellCommandPrefix`、`getShellEnv` 等），差点遗漏多个回归风险。用户提示"充分考虑副作用"后补做了完整源码扫描。

### What Would You Do Differently

1. **先做源码深度扫描再做方案设计**：应该在对内置 bash 工具做完整的源码扫描（`bash.ts` + `shell.ts` + `output-accumulator.ts` + `truncate.ts` + `child-process.ts`）之后再提出方案 A/B/C，而不是在方案确定后才补查。这样能避免 API 选型错误。

2. **brainstorming 阶段应该更早引入 review**：spec v1 存在根本性的架构错误，如果能更早让 review subagent 检查"你选择的 API 是否真的能实现你描述的行为"，可以节省一轮 spec 重写。

### Key Risks for Later Phases

1. **Pipe 切换实现风险**（review v2 指出）：Node.js 的 stdout pipe 不能直接"切换"，超时 detach 时的 pipe 管理方案需要在 plan 阶段明确（可能需要用 WriteStream 从一开始就同时写入内存 buffer 和临时文件）
2. **Shell 发现自实现的 Windows 兼容性**：自实现的 `getShellConfig` 需要覆盖 Windows Git Bash 路径检查
3. **Pi settings 文件格式耦合**：从 `~/.pi/agent/settings.json` 读取 `shellPath`/`shellCommandPrefix` 耦合了 Pi 的内部文件格式，上游变更可能导致断裂

## Harness Usability Review

### Flow Friction

- **用户中途退出处理流畅**：用户说"不要询问我"后，流程自然过渡到自主决策模式，没有卡住。但 brainstorming skill 的"one question at a time"规则在用户不在时有些死板——还好我在此时已完成了大部分提问。
- **Review 分发两次才通过**：第一次 5 MUST FIX 需要完全重写 spec，第二次才通过。这是正常的——review 发现了真实的架构问题。

### Gate Quality

- **Gate 正确放行**：spec_review_v2 verdict=pass + must_fix=0，gate 直接通过。没有 false positive。
- **Review v1 质量很高**：独立审查 subagent 不仅发现了问题，还提供了根因分析和推荐修正方向（"统一改为 child_process.spawn"），这对修复帮助很大。

### Prompt Clarity

- Brainstorming skill 对"技术性需求"的处理合理——跳过了不必要的业务用例探索。
- Skill 的 "Propose 2-3 approaches" 步骤在技术性需求中很实用——方案 A/B/C 的对比帮助用户快速决策。

### Automation Gaps

- **Pi API 可用性验证是手动的**：我需要 `grep` Pi 源码来确认哪些函数被导出（`createLocalBashTool`、`truncateTail` 等）。如果有一个自动化的 "check if X is exported from @mariozechner/pi-coding-agent" 工具会更高效。
- **Settings 文件格式需要源码确认**：`shellPath`、`shellCommandPrefix` 字段名是 grep settings-manager.ts 确认的，如果有 Pi 的 API 文档可以省掉这步。

### Time Sinks

- **Pi 内置 bash 源码分析**占了大部分时间（bash.ts + shell.ts + output-accumulator.ts + truncate.ts + child-process.ts + settings-manager.ts），但这是必要的——没有这个分析就无法发现 API 冲突和回归风险。
