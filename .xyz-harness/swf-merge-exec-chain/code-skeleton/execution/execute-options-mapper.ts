// code-skeleton/execution/execute-options-mapper.ts
//
// 【新模块骨架】合并到 extensions/subagents-workflow/src/execution/execute-options-mapper.ts
//
// 接线层级：[模块内直调] —— 纯 DTO 映射 + AbortSignal 合并（adapter 职责）。
//   mapToExecuteOptions / mergeTimeoutSignal 是叶子映射函数（skeleton-spike：纯计算/格式化
//   函数签名即设计，映射体可写——非业务逻辑）。

import type { AgentCallOpts } from "../orchestration/models/types.ts";
import type { ModelInfo } from "./model-resolver.ts";
import type { ExecuteOptions } from "./types.ts";

/**
 * D-A2: AgentCallOpts → ExecuteOptions 映射。
 *
 * adapter 职责——SubagentService 的 ExecuteOptions 是稳定内部契约，不为 workflow 的
 * AgentCallOpts 做适配（映射归调用方 SAR）。
 *
 * 映射规则（对齐 issues #4 方案 A）：
 *   prompt          → task
 *   agent           → agent（executeAndAwait 内部 resolveIdentity 从 AgentRegistry 读 agentConfig）
 *   schema          → schema（executeAndAwait 内部 formatSchemaInstruction 拼 task，belt-and-suspenders）
 *   schemaEnv       → schemaEnv（D-A6 bridge：runSpawn childEnv 设 PI_WORKFLOW_SCHEMA）
 *   cwd             → cwd（ADR-029：spawn 子进程 cwd 绑定，非 git worktree）
 *   model           → model ?? ctxModel（D-008 填底：opts.model 空时用主 agent model，不调 resolveModel）
 *   skillPath       → skillPath（resolveAgentOpts 解析的 SKILL.md 路径，runSpawn --skill 注入）
 *
 * 忽略字段（委托后由 executeAndAwait 内部机制替代）：
 *   systemPromptFiles —— executeAndAwait resolveIdentity 从 agentConfig.systemPrompt 读，不依赖临时文件
 *   timeoutMs         —— mergeTimeoutSignal 单独处理（合并 signal，不进 ExecuteOptions）
 *   scene/description —— subagents 不消费
 */
export function mapToExecuteOptions(
  opts: AgentCallOpts,
  ctxModel?: ModelInfo,
): ExecuteOptions {
  return {
    task: opts.prompt,
    agent: opts.agent,
    schema: opts.schema,
    // D-A6 bridge：schemaEnv 透传到 ExecuteOptions（新字段，见 shared/types 增量）。
    // tool 层 execute 不传 schemaEnv（ExecuteOptions.schemaEnv 恒 undefined → BC-6）。
    schemaEnv: opts.schemaEnv,
    cwd: opts.cwd,
    // D-008 model 填底：opts.model 优先（workflow 脚本显式指定），空时用 ctxModel（主 agent model）。
    // 不调 resolveModel——auth 校验由 pi 子进程承担（与合并前 pi-runner --model 等价）。
    model: opts.model ?? ctxModel?.id,
    skillPath: opts.skillPath,
    // ExecuteOptions 可选字段不显式设置（undefined 即默认）：
    //   wait/mode —— executeAndAwait 内部固定走 background 管道，不读 wait
    //   maxTurns/graceTurns —— undefined → runSpawn 默认值
    //   fork/worktree —— workflow agent() 不用 fork/worktree（那是 subagent tool 独有能力）
    //   onUpdate/onComplete —— executeAndAwait 不回流（BC-11）
    //   signal —— 由 executeAndAwait 第二参数传（不进 opts）
    //   appendSystemPrompt —— undefined（executeAndAwait resolveIdentity 从 agentConfig 拿 systemPrompt）
  } as ExecuteOptions & { schemaEnv?: string }; // schemaEnv 是 ExecuteOptions 增量字段，见 shared/types
}

/**
 * D-A9: per-call timeoutMs 合并进 AbortSignal。
 *
 * 墙钟 timeoutMs（per-call）+ 外部 signal（run 级 abort）都生效。
 * 缺此合并则 agent({timeoutMs:5000}) 静默无效（BC-9）。
 *
 * 接线：[模块内直调] AbortController + setTimeout + addEventListener（真引 Web API）。
 *
 * @param signal    外部 signal（workflow run 级 controller.signal）
 * @param timeoutMs per-call 墙钟超时（opts.timeoutMs）；undefined/<=0 → 不设超时，原样返回 signal
 * @returns 合并后的 signal（timeoutMs 或外部 signal 任一 abort 都触发）
 */
export function mergeTimeoutSignal(
  signal: AbortSignal,
  timeoutMs?: number,
): AbortSignal {
  // 无 timeoutMs → 直接用外部 signal（不建 controller，零开销）
  if (!timeoutMs || timeoutMs <= 0) {
    return signal;
  }

  // 有 timeoutMs → 建独立 controller，外部 signal + timeout 双触发
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref(); // 不阻止 Node 进程退出（与旧 SAR L57 对称）

  const onExternalAbort = (): void => controller.abort();
  if (signal.aborted) {
    // 外部 signal 已 abort → 立即触发（不等 addEventListener）
    controller.abort();
  } else {
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  // controller.signal abort 后清理 timer + listener（防泄漏——signal 生命周期长于单次 run）
  controller.signal.addEventListener(
    "abort",
    () => {
      clearTimeout(timer);
      if (!signal.aborted) signal.removeEventListener("abort", onExternalAbort);
    },
    { once: true },
  );

  return controller.signal;
}
