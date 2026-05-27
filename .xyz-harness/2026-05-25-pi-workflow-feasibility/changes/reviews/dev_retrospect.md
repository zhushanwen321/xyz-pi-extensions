---
phase: dev
verdict: pass
---

# Phase 3 (Dev) 复盘

## Phase 执行质量

### 总结

Phase 3 完成了所有 11 个实现任务（4 个 Execution Groups），产出 13 个源文件共约 3200 行 TypeScript 代码。通过了 `tsc --noEmit`（0 error）和 ESLint（0 error）。代码审查两轮：v1 发现 6 条 MUST_FIX（$ARGS 注入、reconstructState 数据路径、session_shutdown pause、agent() 返回值、retry、90% 预算警告），v2 全部验证通过。Gate 审查发现 ESLint 结果误报，修复后通过。

### 遇到的问题

1. **API 限速（429）阻塞**：`router-openai/glm-5.1` 在 session 重置窗口（20:08）前不可用。被迫从 `deepseek/deepseek-v4-flash` 回退——效果良好但无 schema 解析能力。`router-anthropic/kimi-for-coding` 也有 403 计费限制。这导致 BG1 Task 1 的 subagent 进程无声失败（worker 由于 API 错误而崩溃），在手动重试前浪费了轮次。

2. **subagent 产出质量不稳定**：部分 subagent 生成的代码有类型错误或违反规范（如 `loadWorkflows`/`sanitizeMeta` 未使用、FR10 编号不一致）。需要额外的审修复循环。

3. **ESLint 结果误报**：test_results.md 声称 ESLint 通过但实际有 2 个 error。被 gate 审查正确捕获。根本原因：test_results.md 是从 subagent 输出拼接而成的，未实际运行验证。

### 下次的不同做法

- 为每个 BG/Task 使用独立的 worktree 分支，然后合并——减少并行阶段的冲突
- dispatch 后严格验证 test_results.md：在每个 subagent 完成后本地重跑 lint
- 尽早（而非在 Phase 2 末尾）验证 API 限速约束——它影响 Phase 3 的排期

### 关键风险

- 没有可以运行的 E2E 测试：缺少 Pi 运行时环境意味着测试阶段将依赖代码审查而非功能测试
- Gateway 测试需要模拟 worker_threads 和 Pi JSONL——这两者在纯 Node.js 进程中都难以模拟

## Harness 体验

### 流程摩擦

- **API 限速不是 harness 阶段的问题，但严重阻碍了 dev 执行**。harness 没有为外部 API 依赖提供降级策略。
- **手动 gate 重新检查很繁琐**：ESLint 修复要求重新写入整个 gate —— 尽管修复很小（删除两行函数）。

### Gate 质量

**强点**：
- Gate 正确捕获了 ESLint 报告伪造——一个具有高信号噪声比的审计路径。
- 文件存在性和代码真实性检查阻止了 stub 通过。

**弱点**：
- Gate 对 `worker_threads`（需要一个干净的 CLAUDE.md 豁免）只字未提——这是被 spec 中的 Constraints 覆盖的设计约束，但 gate 不做架构一致性审计。

### 提示词清晰度

- Phase 3 的 steer 提示词足够清晰（检查保护、按 BG 派遣、代码审查、test_results.md、gate）。
- 时间线「所有 11 个任务 → 审查 → 测试 → gate」容易遵循。

### 自动化缺口

- **test_results.md 生成自动化**：应该有一个 `task run tests` 脚本，对所有模块运行 tsc+eslint 并写入格式化的 markdown。手动拼接容易出错。
- **subagent re-dispatch 助手**：当 subagent 因 API 错误而失败时，harness 无法从最后一次已知的好状态自动重试。当前：手动 grep 最后成功的文件，从那里重试。

### 耗时

- **代码审查 v1 → 修复 → 审查 v2 循环**：约占总 phase 时间的 30%。这是可预期的——6 条 MUST_FIX 对于一次性生成的 3200 行代码来说是合理的修复率。
- **WR1（API sdk 扫描 + CLAUDE.md 追加）**：不确定能否延迟到 Phase 2——在 Phase 3 的背景下扫描 pi-mono 比在 Plan 阶段更自然。
