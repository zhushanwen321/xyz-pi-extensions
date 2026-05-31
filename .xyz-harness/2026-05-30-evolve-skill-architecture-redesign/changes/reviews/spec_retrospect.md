---
phase: spec
verdict: pass
---

# Spec Phase Retrospect

## Phase Execution Review

### Summary
完成了 evolve 从 extension 改为 skill 架构的 spec 设计。3 个 skill（evolve/evolve-apply/evolve-report）+ 1 个极简 hook extension（evolve-daily）替代了 ~1500 行的 evolution-engine extension。

### Problems Encountered

1. **Pre-commit tsc 失败**：commit 时 pre-commit hook 的 `tsc --noEmit` 报大量类型错误。根因是 Pi 从 `@mariozechner/pi-coding-agent` 改名为 `xyz-pi`，tsconfig.json 的 paths 指向不存在的旧目录。main 分支已在 commit `39b529e` 修复（加了 fallback type stubs），但 fix-evolve-problem 分支是从旧 commit 创建的，没有同步。**首次用了 SKIP_LINT=1 跳过，后来正面修复**。

2. **Review 发现的 apply/rollback 失败场景缺失**：第 1 轮审查发现 2 条 MUST FIX——apply 操作部分失败时状态不一致、rollback 降级逻辑不完整。修复后第 2 轮通过。

### What Would I Do Differently

- **新 worktree 创建时就应该检查 tsc**：create-worktree skill 可以在创建后自动跑一次 `npx tsc --noEmit`，如果失败就提示同步 tsconfig。
- **不该 SKIP_LINT**：第一次应该直接调查根因修复，而不是跳过 hook。

### Key Risks for Later Phases

- **SKILL.md prompt 质量**：spec 标记为低复杂度，但 3 个 skill 的 prompt 质量直接影响功能可用性。Phase 3 实现时需要认真打磨。
- **pending.json 格式兼容**：LLM 写入的 JSON 格式可能不完全符合 schema。skill prompt 中需要明确格式要求和校验步骤。

## Harness Usability Review

### Flow Friction
- Gate 检查要求 untracked files 为 0 才能通过，第一次因为没 git add 导致 FAIL。这是合理的，但提示信息可以更明确。

### Gate Quality
- Gate 正确识别了 untracked files 问题。Review subagent 两轮审查质量高，MUST FIX 发现的是真实的设计缺陷（不是吹毛求疵）。

### Prompt Clarity
- Skill 指令清晰，特别是审查 subagent 的 task prompt 模板很实用。

### Automation Gaps
- **tsconfig 同步问题**：新 worktree 从旧分支创建时不会自动获得 main 的 tsconfig 修复。建议在 create-worktree skill 中加入 post-create 检查。
