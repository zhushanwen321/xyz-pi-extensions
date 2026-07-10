/**
 * Workflow Extension — Budget 值对象
 *
 * Token / cost 预算值对象（D-12）。纯数据 + 不变式守卫，无副作用。
 *
 * 设计：
 * - 无 onConsume 回调（值对象不应持可变回调）。
 * - soft limit 通知由 lifecycle 层 consume 后查 isSoftLimitReached 发出（职责分离）。
 * - 90% 预警用查询式 isThresholdReached（无状态，可重复查）。
 * - maxTokens===0 视为不限制（守卫，避免首个 agent 完成误判 budget_limited）。
 *
 * 加权 token 计算口径（INPUT/CACHE_READ/CACHE_WRITE/OUTPUT_WEIGHT）由 shared 包
 * `@zhushanwen/pi-budget-accounting` 提供——goal 与 workflow 共享同一口径，
 * 详见该包 src/accounting.ts 头注释（四桶互斥 + cacheRead 失真说明）。
 *
 * 层归属：Engine。
 *
 * 参考：domain-models.md §4（字段/不变式/操作）。
 */
import {
  CACHE_READ_WEIGHT,
  CACHE_WRITE_WEIGHT,
  INPUT_WEIGHT,
  OUTPUT_WEIGHT,
  weightTokens,
} from "@zhushanwen/pi-budget-accounting";
import type { AgentUsage } from "./types.js";

/** Soft limit：总调用数超此值发预警（FR-7，从 ConcurrencyGate 迁入）。 */
export const SOFT_MAX_AGENTS_WARNING = 500;

// 权重常量从 shared 包 re-export，保持现有 import 站点（budget.test.ts 等）不变。
export { CACHE_READ_WEIGHT, CACHE_WRITE_WEIGHT, INPUT_WEIGHT, OUTPUT_WEIGHT };

/**
 * Budget 值对象。
 *
 * 不变式（domain-models.md §4）：
 * - maxTokens > 0 守卫：maxTokens===0 或 undefined 视为不限制
 * - maxCost > 0 守卫：同上
 * - consume 只累加，不减；isExceeded 只读
 * - 无回调字段——所有副作用由调用方在 consume 后查询决定
 */
export class Budget {
  readonly maxTokens?: number;
  readonly maxCost?: number;
  readonly maxTimeMs?: number;
  usedTokens = 0;
  usedCost = 0;
 /** 总调用计数（soft limit 用，从 ConcurrencyGate.totalCallCount 迁入）。 */
  totalCallCount = 0;

  constructor(opts: {
    maxTokens?: number;
    maxCost?: number;
    maxTimeMs?: number;
    usedTokens?: number;
    usedCost?: number;
    totalCallCount?: number;
  } = {}) {
    this.maxTokens = opts.maxTokens;
    this.maxCost = opts.maxCost;
    this.maxTimeMs = opts.maxTimeMs;
    this.usedTokens = opts.usedTokens ?? 0;
    this.usedCost = opts.usedCost ?? 0;
    this.totalCallCount = opts.totalCallCount ?? 0;
  }

 /**
 * 累加一次 agent 调用的 usage（加权口径）。
 *
 * 四项 token 经 shared weightTokens 加权求和（INPUT/CACHE_READ/CACHE_WRITE/OUTPUT_WEIGHT），
 * 而非原始 token 数直接相加。retry 间的真实消耗如实记录，避免预算被低估。
 * 详见 shared `@zhushanwen/pi-budget-accounting` 的口径说明。
 */
  consume(usage: AgentUsage): void {
    this.usedTokens += weightTokens(usage);
    this.usedCost += usage.cost;
  }

 /** 累加调用计数（每次 agent dispatch 后调用）。 */
  incrementCallCount(): void {
    this.totalCallCount += 1;
  }

 /**
 * 是否超 token / cost 预算（FR-3）。
 *
 * maxTokens===0 或 undefined 视为不限制（守卫）；
 * maxCost===0 或 undefined 视为不限制。
 * 时间预算（maxTimeMs）不由本方法判断——它是 wall-clock 约束，需参照 startedAt，
 * 由 lifecycle 层的 scheduleTimeBudget（runWorkflow/resumeRun 内 setTimeout）
 * 独立调度，到期 abortRun(doneReason="time_limited")。
 */
  isExceeded(): boolean {
    if (this.maxTokens !== undefined && this.maxTokens > 0 && this.usedTokens >= this.maxTokens) {
      return true;
    }
    return this.maxCost !== undefined && this.maxCost > 0 && this.usedCost >= this.maxCost;
  }

 /**
 * 是否达到 soft limit（FR-7）。
 *
 * totalCallCount > SOFT_MAX_AGENTS_WARNING（500）。
 * 调用方（lifecycle）在 consume/incrementCallCount 后查询，
 * 命中时发通知（无状态——可重复查询）。
 */
  isSoftLimitReached(): boolean {
    return this.totalCallCount > SOFT_MAX_AGENTS_WARNING;
  }

 /**
 * 是否达到 token 预算的给定比例阈值（如 0.9 = 90% 预警）。
 *
 * 纯查询，无状态——调用方负责去重（旧 _budgetWarningSent 语义由 lifecycle 层用
 * 外部 Set 或 once-listener 实现）。maxTokens 未设或为 0 时返回 false。
 */
  isThresholdReached(ratio: number): boolean {
    return (
      this.maxTokens !== undefined &&
      this.maxTokens > 0 &&
      this.usedTokens >= this.maxTokens * ratio
    );
  }
}
