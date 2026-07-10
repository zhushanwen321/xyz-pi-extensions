/**
 * Budget 加权 token 计算 — 纯函数，零 Pi 依赖。
 *
 * usedTokens 不是四项原始 token 的简单求和，而是加权后的「等效消耗」，
 * 反映不同 token 桶的真实计费/处理开销差异：
 * - input（非缓存新增）：首次见到、需完整处理的新内容，权重 1（基准）
 * - cacheRead（命中缓存）：读取历史，开销极低，按 1/50 折算（权重 0.02）
 * - cacheWrite（首次写入缓存）：不计入 budget（权重 0）
 * - output：模型自回归生成，开销最高，权重 2
 *
 * 四桶互斥（pi provider 保证）：
 * - Anthropic: input_tokens / cache_read_input_tokens / cache_creation_input_tokens 是独立 API 字段
 * - OpenAI: 原始 input_tokens 含 cached，pi 主动减去 cachedTokens 后输出，最终 input/cacheRead 互斥
 * 因此 input/cacheRead 不会重复计数，无需去重。
 *
 * 这避免了长 session 中 cacheRead 随轮次单调累积导致 budget 被快速烧穿的失真
 * （cacheRead 在 N 轮里被报 N 次，但去重上下文只有一份）。
 */

/**
 * Token 消耗输入（最小公共类型）。
 *
 * goal 的 TokenUsage（可选字段）和 workflow 的 AgentUsage（全必填 + cost/contextTokens/turns）
 * 都结构兼容此类型。双方各自构造此对象传入 weightTokens。
 */
export interface TokenConsumption {
  /** 非缓存新增输入 token（pi 保证不含 cacheRead） */
  input: number;
  /** 模型生成输出 token */
  output: number;
  /** 命中缓存的输入 token（与 input 互斥） */
  cacheRead: number;
  /** 首次写入缓存的输入 token */
  cacheWrite: number;
}

// ── 加权系数 ──────────────────────────────────────────

/** input（非缓存新增）权重 — 基准。 */
export const INPUT_WEIGHT = 1;

/** cacheRead（命中缓存）权重 — 1/50 折算。 */
export const CACHE_READ_WEIGHT = 0.02;

/** cacheWrite（首次写入缓存）权重 — 不计入 budget。 */
export const CACHE_WRITE_WEIGHT = 0;

/** output 权重 — 2 倍。 */
export const OUTPUT_WEIGHT = 2;

// ── 加权求和 ──────────────────────────────────────────

/**
 * 四项 token 加权求和，返回「等效消耗」。
 *
 * 各桶按 INPUT/CACHE_READ/CACHE_WRITE/OUTPUT_WEIGHT 折算后求和。
 * input/cacheRead 互斥（pi provider 保证），无需去重。
 */
export function weightTokens(c: TokenConsumption): number {
  return c.input * INPUT_WEIGHT
    + c.output * OUTPUT_WEIGHT
    + c.cacheRead * CACHE_READ_WEIGHT
    + c.cacheWrite * CACHE_WRITE_WEIGHT;
}
