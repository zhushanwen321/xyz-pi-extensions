---
phase: dev
verdict: pass
---

# Dev Phase Retrospect

## Phase Execution Review

### Summary
实现了 evolve-skill-architecture-redesign 的全部 5 个 Task：evolve-daily extension（38 行 TS）+ 3 个 SKILL.md（纯 Markdown prompt）+ 旧 extension 清理和 symlink 安装。经历 2 轮审查修复（6 条 MUST FIX），最终 5 步专项审查全部通过。

### Problems Encountered

1. **evolve-daily analyzer 失败残留文件**（Robustness #1）：Python analyzer 执行失败时可能写入不完整的 JSON 文件，后续 `existsSync` 会误判为"今天已生成"。修复：catch 块中 `unlinkSync` 清理。

2. **evolve-apply heredoc 多行破坏 JSONL**（BLR #2）：Bash heredoc 写入 history.jsonl 时，如果 instruction 字段包含换行符，会产生非法多行记录。修复：改用 `python3 -c "json.dumps()"` 确保单行输出。

3. **ROLLBACK 失败路径不完整**（BLR #1 + Integration #1）：三处遗漏——
   - 备份恢复失败仍写 history（v1 修复）
   - 备份缺失时步骤 6-8 仍执行（v2 修复）
   - edit 失败后 backup 残留未清理（v1 修复）
   这暴露了一个模式：SKILL.md 作为 LLM 执行指令，错误分支的"停止"语义必须显式声明（`STOP HERE`），不能依赖隐式的"不继续"。

4. **rollback 未更新 pending.json**（Robustness #3）：rollback 后 suggestion 状态应恢复为 pending，但原始设计中遗漏了这个步骤。

5. **pending.json 写入失败无提示**（Robustness #4）：evolve 的分析结果如果 write 失败，建议会静默丢失。添加了失败时的用户提示和 fallback 展示。

6. **ESLint 缺少 typescript-eslint**（环境问题）：worktree 中 `npm install` 后 eslint 才能运行。非代码问题，是 worktree 依赖隔离的固有摩擦。

### What Would I Do Differently

- **SKILL.md 的错误分支应使用模板化守卫**：每次写"如果 X 失败 → ABORT"时，应该同时列出"ABORT 意味着不执行后续所有步骤"。纯文本文档缺乏代码级的 `return`/`throw` 语义，需要更冗长的显式声明。
- **审查可以更早介入**：Task 1-4 实现完成后、Task 5 清理前，可以先跑一轮 BLR。这样 rollback 的问题在清理阶段就能发现，避免审查后发现 SKILL.md 需要大改后重新 commit。

### Key Risks for Later Phases

- **SKILL.md 实际执行效果未验证**：所有 SKILL.md 是 prompt 指令，实际 LLM 执行时的行为依赖模型理解能力。Phase 4 测试阶段需要手动验证每个 skill 的触发和执行。
- **evolve-daily 的 `pi.exec` 行为假设**：代码假设 `pi.exec` 是异步执行且支持 timeout 参数。如果 Pi runtime 的实际 API 签名不同，需要调整。

## Harness Usability Review

### Flow Friction

- **5 步专项审查对纯 prompt 项目偏重**：这个项目唯一代码文件只有 38 行 TS，但 5 步审查流程产生了 8 个 review 文件（4 v1 + 3 v2 + 1 taste v1）。其中 Standards Review 和 Taste Review 几乎没有实质内容（38 行代码没什么好审的）。对于这种"主要是文档/prompt"的项目，审查步骤可以降级为 2-3 步（BLR + Robustness + Integration，跳过 Standards/Taste）。

### Gate Quality

- Gate 正确验证了所有 v2 review 文件的 verdict 和 must_fix。gate 脚本稳定可靠。

### Automation Gaps

- **SKILL.md 验证无自动化手段**：不同于 TypeScript 有 tsc/eslint，Markdown prompt 文件没有静态验证工具。BLR 审查 subagent 发现了 heredoc 问题，但这依赖 LLM 的理解能力而非自动化检查。考虑为 SKILL.md 建立一个轻量的 linter（检查数据路径是否存在、JSON 模板是否合法）。
