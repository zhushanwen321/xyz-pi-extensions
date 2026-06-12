---
verdict: pass
---

# 业务用例 — workflow-cc-compat-v2

## UC-1: Review-Fix 循环（跨平台脚本）

- **Actor**: 开发者
- **Preconditions**: Pi 已安装，`structured-output` 扩展已安装，项目中有代码需要 review
- **Main Flow**:
  1. 开发者在 Pi 中执行 `ultracode 创建一个 review-fix-loop workflow`
  2. AI 生成 CC 格式的 workflow 脚本（使用 `export const meta`, `args.maxIterations`, `agent(prompt, {schema, phase})`）
  3. 脚本在 Pi 上执行，config-loader 正确解析 `{title, detail}` 格式的 phases
  4. `agent()` 调用时 schema 通过临时文件注入子进程 system prompt
  5. LLM 调用 `structured-output` 工具返回结构化的 review 结果
  6. 若首次未调用 SO（弱模型场景），系统自动重试一次
  7. TUI 按 Review/Fix 两个 phase 分组显示 trace（延后到 FR-3）
  8. 循环在 must-fix=0 或达到 `args.maxIterations` 时停止
- **Alternative/Exception Paths**:
  - 3a. 脚本使用旧 Pi 格式（`const meta`, `$ARGS`）→ 仍可正常执行（向后兼容）
  - 5a. LLM 首次未调用 SO 但调用了其他工具 → 不重试，返回失败（hasToolCall 盲区）
  - 6a. 重试仍失败 → 返回错误，workflow 脚本通过 try-catch 处理
- **Postconditions**: 同一份 CC 格式脚本在 Pi 和 Claude Code 上都能正确执行
- **Module Boundaries**:
  - config-loader: phases 解析
  - agent-pool: schema 注入 + 重试
  - worker-script: args/phase/parallel/pipeline/budget 全局注入
  - orchestrator: 临时文件管理 + trace 记录
- **AC 覆盖映射**: AC-1.1, AC-1.2, AC-1.3, AC-1.4, AC-2.1, AC-2.2, AC-2.3, AC-2.5

## UC-2: Structured Output 首次失败自动恢复

- **Actor**: workflow 脚本（系统内部行为）
- **Preconditions**: agent() 调用传入了 schema，模型可能忽略 SO 指令（弱模型）
- **Main Flow**:
  1. agent() 调用传入 `{schema: REVIEW_SCHEMA}`
  2. orchestrator 将 schema 写入临时文件，通过 `--append-system-prompt` 注入
  3. 子进程首次运行返回纯文本，未调用 structured-output，未调用任何其他工具
  4. system 检测到 `!parsedOutput && !hasToolCall`，触发重试
  5. 写入加强版临时文件（`[RETRY - CRITICAL]` 前缀）
  6. 子进程第二次运行成功调用 structured-output
  7. 返回正确结果，用户无感知
- **Alternative/Exception Paths**:
  - 4a. 子进程调用了其他工具（read/bash 等）→ 不重试，视为 agent 仍在工作（但如果已 exit 则报错）
  - 6a. 重试仍失败 → 返回错误，workflow 脚本可 try-catch
- **Postconditions**: 弱模型场景下 workflow 自动恢复，成功率显著提升
- **Module Boundaries**: agent-pool (spawnAndParse 重试逻辑), orchestrator (临时文件写入)
- **AC 覆盖映射**: AC-1.1, AC-1.3, AC-1.4

## UC-3: /workflows 全屏监控 [延后，依赖 FR-3]

> 延后到下一阶段。本阶段不实现。

- **Actor**: 开发者
- **Preconditions**: workflow 正在运行或已完成
- **Main Flow**: [延后]
- **AC 覆盖映射**: AC-3.1 ~ AC-3.5 [POSTPONED]
