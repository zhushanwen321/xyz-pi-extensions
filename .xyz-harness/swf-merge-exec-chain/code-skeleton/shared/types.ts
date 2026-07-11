// code-skeleton/shared/types.ts
//
// 【增量类型声明】合并到 extensions/subagents-workflow/src/execution/types.ts（ExecuteOptions）。
// 本文件声明 ExecuteOptions 的新增 schemaEnv 字段（D-A6 bridge）。
//
// 设计基线：D-A6（schema bridge）/ BC-6（tool 层不传 schemaEnv，行为不变）。

// ── ExecuteOptions 增量字段 ──
//
// 现有 ExecuteOptions（subagents/src/types.ts）字段（迁移不动）：
//   task, agent?, wait?, model?, thinkingLevel?, skillPath?, appendSystemPrompt?,
//   schema?, maxTurns?, graceTurns?, signal?, ctxModel?, onUpdate?, onComplete?,
//   fork?, worktree?, cwd?
//
// 新增字段（合并时并入 ExecuteOptions interface）：

export interface ExecuteOptionsSchemaEnvPatch {
  /**
   * D-A6: schema JSON 字符串，激活 structured-output 扩展注册 tool。
   *
   * 语义（BC-6 保证）：
   *   - tool 层 execute（subagent-tool）不传 → undefined → runSpawn childEnv 不设 PI_WORKFLOW_SCHEMA
   *     → structured-output tool 不注册（与合并前 tool 层一致）
   *   - SAR 委托（mapToExecuteOptions）从 AgentCallOpts.schemaEnv 透传 → runSpawn childEnv 设
   *     → structured-output tool 注册（BC-8 等价，workflow 编排层需要）
   *
   * 与 schema 字段的关系（belt-and-suspenders）：
   *   - schema（Record）：executeAndAwait 内部 formatSchemaInstruction 拼 task 末尾（文本提示）
   *   - schemaEnv（string）：runSpawn childEnv 设 PI_WORKFLOW_SCHEMA（env 激活 tool 注册）
   *   - 两者互补：schema 提示 LLM 调 tool，schemaEnv 让 tool 真正可用
   */
  schemaEnv?: string;
}

// ── 合并声明 ──
//
// 合并到 execution/types.ts 时，ExecuteOptions interface 追加 schemaEnv?: string 字段：
//
//   export interface ExecuteOptions {
//     // ... 现有字段 ...
//     /** D-A6: schema env bridge（workflow 编排层用，tool 层不传，见 shared/types 增量声明） */
//     schemaEnv?: string;
//   }
//
// 影响面：
//   - executeAndAwait opts 参数类型（ExecuteOptions）自动含 schemaEnv
//   - runAndFinalize 构造 RunOptions 时透传 opts.schemaEnv（见 session-runner-extend.ts）
//   - RunOptions（session-runner.ts）同步加 schemaEnv?: string
//   - mapToExecuteOptions（execute-options-mapper.ts）设置 schemaEnv: opts.schemaEnv
//
// BC-6 验证点：
//   - subagent-tool 的 startHandler 构造 ExecuteOptions 时不设 schemaEnv → undefined（行为不变）
//   - grep 验证：subagent-tool.ts 无 schemaEnv 引用（tool 层零感知）
