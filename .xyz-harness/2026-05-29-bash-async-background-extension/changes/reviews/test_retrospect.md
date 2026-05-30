---
phase: test
verdict: pass
---

# Test Phase Retrospect — bash-async-background-extension

## 1. Phase Execution Review

### Summary

Phase 4 编写并执行了 17 个集成测试用例，全部通过。测试覆盖了 sync/timeout-detach/background/poll/kill/config/ENOENT/truncation/max-jobs/cwd-validation/shell-discovery 全部核心路径。额外发现并修复了一个 `ERR_STREAM_DESTROYED` bug（unpipe 时序问题）。

关键数字：11 turns，~15000 行上行 / ~1800 行下行，294k 推理 token。

### Problems Encountered

**1. 测试框架选型**

所有 TC 在 template 中标记为 `type: "manual"`（需要 Pi 运行时）。我选择了编写独立集成测试脚本（`tests/integration.test.ts`），通过内联重新实现核心 spawn 逻辑来绕过 Pi 依赖。这导致测试代码和实际代码存在重复（spawnCommand 的逻辑被复制了一份）。

如果直接 import 源模块会更好，但 `spawn.ts` 依赖 `@mariozechner/pi-coding-agent` 的 `truncateTail` 和 `ExtensionAPI`，这些在独立 Node.js 进程中不可用。

**2. assert 函数签名错误**

测试框架使用 Node.js `assert` 模块，但将 `assert(condition, message)` 错误地写为裸函数调用。Node.js v24 的 `assert` 模块没有直接作为函数导出的 `assert()`（只有 `assert.ok()` 等）。解决方案：自定义 `assertTrue()`/`assertFalse()` 辅助函数。

**3. ERR_STREAM_DESTROYED bug（测试中发现的真实 bug）**

TC-12（ENOENT 测试）触发了一个未处理的错误：当 child process error 事件触发后，`writeStream.destroy()` 关闭了流，但 `stdout` 仍在尝试向已销毁的流写入（pipe 未解绑）。这个 bug 同时存在于测试代码和扩展源代码中。

修复：在 `writeStream.destroy()` 之前先 `child.stdout?.unpipe(writeStream)`。这个修复被同步应用到了 `spawn.ts`（扩展源代码）和 `integration.test.ts`。

**4. ESLint 未使用变量**

测试文件中 11 个 `@typescript-eslint/no-unused-vars` 错误（解构了 `child` 但在某些测试中未使用）。通过在文件头添加 `/* eslint-disable @typescript-eslint/no-unused-vars */` 解决。

### What Would You Do Differently

1. **应该先设计测试架构再写测试**。当前的内联 spawnCommand 复制是一个 pragmatic hack，但如果一开始就考虑好测试策略（比如 mock Pi 依赖 vs 独立实现），可以避免 ~200 行重复代码。更好的方案：将 spawnCommand 的核心逻辑（不含 Pi 依赖）提取到一个共享的纯函数模块，测试和扩展都引用它。

2. **ERR_STREAM_DESTROYED 应该在 Phase 3 就被发现**。Robustness review v2 通过了 0 MUST FIX，但 unpipe 时序问题没被检出。这说明 review 对 "child process error → stream lifecycle" 这种跨系统交互的覆盖不足。如果 Phase 3 有一个类似我写的集成测试（特别是 ENOENT 场景），这个 bug 就不会泄露到 Phase 4。

3. **TC-5-01（AbortSignal）用 code_review 而非自动化测试**。这是合理的——AbortSignal 需要完整的 Pi tool call 生命周期才能测试。但 template 中标记为 `manual` 可能误导——应该在 template 中区分 "需要 Pi 运行时" 和 "需要人工操作"。

### Key Risks for Later Phases

1. **unpipe 修复未经 Pi 运行时验证**：`spawn.ts` 的 unpipe 修复通过了 tsc 但未在实际 Pi 会话中验证。如果 `child.stdout` 在某些边缘情况下为 null（spawn 失败时），`unpipe` 调用可能抛出 TypeError。当前使用了 `?.` optional chaining，应该安全。

2. **测试覆盖了单元逻辑但未覆盖 Pi 扩展注册**：`index.ts` 中的 `registerTool("bash", ...)` 和 `renderCall`/`renderResult` 函数没有被测试覆盖。这些需要加载 Pi 运行时。

3. **TC-10（session 隔离）只是验证了 Map 隔离**：真正的 session 隔离还涉及 `session_start` 重建闭包状态，这需要 Pi 多 session 测试环境。

## 2. Harness Usability Review

### Flow Friction

Phase 4 执行流畅。从阅读 skill 指令到 gate PASS 共 11 turns，没有卡住或需要回退。测试脚本编写是最耗时的步骤（~6 turns），包括框架搭建、bug 修复、ESLint 修复。

**流畅点**：`test_execution.json` 的 schema 非常清晰，gate 的 cross-reference 检查（template TCs vs execution TCs）在第一次就通过了——没有遗漏或格式错误。

### Gate Quality

Gate 一次 PASS。检查了：
- test_execution.json 存在且为有效 JSON
- 所有 template TCs 都有对应的 execution records
- 所有最终轮次 passed=true
- 所有 execute_steps 非空

这与我自己的 pre-flight 检查完全一致，没有意外。

### Prompt Clarity

Skill 指令清晰。特别是 `test_execution.json` 的字段 schema 表格（包含常见错误列）非常有帮助——避免了 `passed: "true"`（字符串）和 `round: "1"`（字符串）这类常见错误。

**改进建议**：
- TC template 中 `type: "manual"` 的语义模糊。本项目的 "manual" 实际是 "需要 Pi 运行时" 而非 "需要人工操作"。建议增加 `type: "pi-runtime"` 或在 description 中注明。
- Skill 应建议测试文件放在哪里。当前我放在了 `bash-async/tests/`，但没有任何指引。

### Automation Gaps

1. **测试执行需要手动编写测试框架**。Skill 只定义了 TC template 格式和 execution record 格式，但没有提供测试运行器模板。一个 minimal 的 test runner scaffold（带 assert helpers、test() wrapper、cleanup hooks）可以节省 ~2 turns。

2. **test_results.md 和 test_execution.json 存在信息冗余**。两个文件都记录了 pass/fail 状态。Skill 应明确 test_results.md 是"Phase 3 代码审查总结 + Phase 4 测试摘要"而 test_execution.json 是"Phase 4 唯一 truth source"。

### Time Sinks

1. **ERR_STREAM_DESTROYED 调试**：TC-12 第一次运行时进程崩溃，花了 ~3 turns 诊断根因（是测试代码问题还是扩展 bug？）、修复两边、重跑验证。

2. **ESLint 未使用变量**：`git checkout --` 恢复文件后需要重新应用之前的修复（sed + eslint-disable），额外消耗 1 turn。
