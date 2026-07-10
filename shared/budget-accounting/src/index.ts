/**
 * Budget Accounting — 桶出口（barrel export）
 *
 * 所有类型、常量、函数从子模块重新导出。
 */

export {
  CACHE_READ_WEIGHT,
  CACHE_WRITE_WEIGHT,
  INPUT_WEIGHT,
  OUTPUT_WEIGHT,
  weightTokens,
} from "./accounting.js";
export type { TokenConsumption } from "./accounting.js";
