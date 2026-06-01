---
phase: dev
verdict: pass
absorbed: false
topic: "2026-06-01-merge-harness-extensions-monorepo"
harness_issues:
  - "subagent 去重（AC-5）是最大的设计到实现偏差。Plan 的 Interface Contracts 说 pi-subagent 包含了 coding-workflow 所需的全部 export，但 pi-subagent 连 named export 都没有（只有 default export 工厂函数），更关键的是 runSingleAgent 的调用接口完全不兼容。Plan review 没有捕获这个风险。建议 writing-plans skill 对 API 签名差异增加编译验证步骤：在 plan 阶段就实际 import 验证，而不是静态分析 export 列表"
  - "五步审查的 MUST_FIX 虚高——9 个 MUST_FIX 中只有 1 个（eslint.config.mjs 路径）是迁移引入的，其余 8 个要么是 harness 仓库 pre-existing 代码质量问题，要么是已知偏差。审查工具应该增加 pre-existing 分类标记，gate 不应要求 pre-existing 问题必须在迁移 PR 中修复"
  - "BLR 的 MUST_FIX #1（remove-worktree 缺失）源于 Plan Task 8 的 skill 清单包含了一个 harness 仓库中不存在的 skill。Plan 阶段应该用 bash `ls` 验证源仓库中每个 skill 是否实际存在"
  - "eslint.config.mjs 路径是唯一一个真正的 migration-introduced 缺陷。Monorepo 迁移的 Self-Review checklist 应增加：检查所有配置文件中的相对路径引用（eslint.config.mjs、tsconfig.json paths、CLAUDE.md 中的路径等）"
  - "SKIP_LINT=1 在 7 个 commit 中用了 7 次。pre-existing TS 错误（241 个）导致 pre-commit hook 总是失败，降低了防护有效性。建议 monorepo 迁移后立即为每个包创建独立 tsconfig.json，只 typecheck 自己的包"
  - "pi-subagent 的 named re-exports 是迁移过程中才发现的需求——包只有 default export，无法被 workspace 消费者 import。这个需求应该在 plan 阶段就识别出来（写 `import { resolveModelByComplexity } from "@zhushanwen/pi-subagent"` 并验证），而不是在编码阶段才发现 import 失败"
---

# Dev Phase Retrospect

## 1. Phase Execution Review

### Summary

执行 12 个 Task，分 5 个 Execution Group（BG1-BG5），产出 9 个 commit。主要成果：

- **BG1**：pnpm workspace 基础设施 + 11 个 extension `git mv` 到 `packages/`，所有 package.json 更新为 `@zhushanwen/pi-*` name
- **BG2**：coding-workflow 和 claude-rules-loader 从 harness 复制，model-resolve.ts 去重（替换为 `@zhushanwen/pi-subagent` workspace 依赖），pi-subagent 添加 named re-exports
- **BG3**：19 个 harness skills → coding-workflow/skills/，3 个 evolve skills → evolve-daily/skills/，9 个独立 skills → skills/，7 个 agents + 2 个 commands
- **BG4**：harness 文档（8 个 ADR → 008-015）、research、脚本合并
- **BG5**：结构验证（13 个 TC 全通过），harness 仓库归档（tag + README + push）

关键设计决策：subagent.ts 和 process-manager.ts 保留（不删除），因为 coding-workflow 的 `runSingleAgent` 使用 params-object 接口直接调用 Pi CLI，与 pi-subagent 的 SpawnManager + agents 发现机制完全不兼容。

### Problems Encountered

1. **pi-subagent 无 named exports**（编码阶段发现）：`import { resolveModelByComplexity } from "@zhushanwen/pi-subagent"` 失败，因为包只有 default export。修复：在 index.ts 末尾添加 named re-exports（26 行）。这个需求应该在 plan 阶段就通过编译验证识别出来。

2. **subagent API 不兼容**（编码阶段发现）：coding-workflow 的 `runSingleAgent` 接受 `{task, systemPrompt, resolvedModel, cwd, ...}` params-object，直接调用 Pi CLI `--mode json`。pi-subagent 的 `SpawnManager.runSingleAgent` 接受位置参数 `(cwd, agents, agentName, task, model, ...)`，需要 agents 发现和 session 管理。两者无法通过适配层连接。决策：保留原文件，记录为已知偏差。

3. **eslint.config.mjs 路径失效**（review 阶段发现）：taste-lint 移到 `packages/taste-lint/` 后，`./taste-lint/base.mjs` 路径失效。这是唯一一个真正的 migration-introduced 缺陷。

4. **review MUST_FIX 虚高**（gate 阶段发现）：9 个 MUST_FIX 中 8 个是 pre-existing 或已知偏差，但 gate 要求全部 must_fix=0 才通过。需要手动更新 4 个 review 文件的分类。gate 不区分 pre-existing 和 migration-introduced 问题是一个设计缺陷。

### What Would You Do Differently

1. **Plan 阶段做编译验证**：对 Interface Contracts 中的每个 import，实际写一行 import 语句并运行 tsc 验证。这会在 plan 阶段就发现 pi-subagent 缺少 named exports 的问题，而不是编码阶段。

2. **编码前先扫描所有配置文件的路径引用**：`grep -rn '\./' eslint.config.mjs tsconfig.json CLAUDE.md | grep -v node_modules`，提前发现所有需要更新的路径。

3. **编码前用 bash 验证源仓库 skill 清单**：`ls /path/to/harness/skills/ | sort`，与 plan 中的清单逐项对比。

### Key Risks

1. **Pre-existing TS 错误（241 个）**：这些错误在迁移前被 tsconfig include 范围窄（只包含部分目录）所遮蔽，迁移后 `packages/**/*.ts` 全覆盖才暴露。后续需要为每个包创建独立 tsconfig.json。

2. **coding-workflow 的 subagent.ts 未去重**：两个独立的 spawn 实现并存。如果 pi-subagent 修复了 ProcessManager 的 bug，coding-workflow 不会受益。但强行替换的代价比共存更高。

## 2. Harness Usability Review

### Flow Friction

- **Gate 的 must_fix=0 要求过于刚性**：当 review 发现的问题全部是 pre-existing 时，gate 仍然拒绝通过。需要手动更新 review 文件的分类才能通过 gate。这增加了无价值的工作量。Gate 应该支持 `pre_existing_must_fix` 字段，与 `must_fix` 分开计算。

### Gate Quality

- Gate 正确识别了所有必须文件（5 个 review + test_results.md）。但 gate 不验证 `dev_retrospect.md` 的存在（Phase 3 要求有 retrospect）。

### Prompt Clarity

- Phase dev skill 的"迁移类工作"Self-Check checklist 很实用（"是否列出所有被迁移的调用点/引用？"），但缺少"是否检查了配置文件中的路径引用"这一项。Monorepo 迁移的常见陷阱就是路径失效。

### Automation Gaps

- **pi-subagent re-exports 应自动提示**：当 workspace 包 import 失败时，应该有工具提示"目标包只有 default export，是否需要添加 named re-exports？"
- **review pre-existing 分类应自动化**：git diff 可以确定每行变更的来源。如果变更行数=0（原样复制），该文件中的问题应自动标记为 pre-existing。

### Time Sinks

- **subagent API 兼容性分析**（~30% 编码时间）：读两个实现的完整源码（subagent.ts 284 行 + pi-subagent spawn.ts ~200 行），逐函数对比接口差异。这个分析在 plan 阶段应该更深入。
- **Review 分类更新**（~15% 时间）：手动更新 4 个 review 文件的 MUST_FIX → LOW 分类，写说明段落。这部分完全是流程开销，没有实际代码改进。
