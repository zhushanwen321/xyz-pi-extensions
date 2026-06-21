/**
 * 跨模块共享常量。
 *
 * 历史：RUNID 相关常量曾在 3 个文件各自定义且同名不同义
 * （orchestrator 的 RUNID_SLICE_LENGTH=8 用于生成，commands/index 的
 * RUNID_SLICE_LENGTH=16/20 用于显示），本次提取到单一来源消除歧义。
 * 显示长度各文件保留原值（行为不变），仅统一命名。
 */

// ── runId 生成（orchestrator 生成 runId 时使用）─────────────────
export const RUNID_RADIX = 36;
export const RUNID_SLICE_START = 2;
// slice end 索引（原 orchestrator RUNID_SLICE_LENGTH=8，配合 SLICE_START=2 切出 6 字符）
export const RUNID_SLICE_END = 8;

// ── runId 显示（各显示场景的截断长度，值保留历史行为）─────────────
export const RUNID_CMD_SHORT = 12;   // 原 commands RUNID_SHORT_LENGTH
export const RUNID_CMD_LONG = 16;    // 原 commands RUNID_SLICE_LENGTH
export const RUNID_INDEX_SHORT = 16; // 原 index RUNID_SHORT_LENGTH
export const RUNID_INDEX_LONG = 20;  // 原 index RUNID_SLICE_LENGTH

// ── 时间 ────────────────────────────────────────────────────────
export const MS_PER_SEC = 1000;
