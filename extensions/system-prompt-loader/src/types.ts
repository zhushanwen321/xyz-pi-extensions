/**
 * types.ts — 跨层 DTO / 值对象类型定义（依赖图叶子，无出向依赖）
 *
 * 变化轴：数据结构定义。被 config/engine/discovery/index 各文件 import。
 * [骨架] ②§4 核心模型 + ③#1 + ⑤sourceId/SourceMeta（FR-3.1 排序关联）。
 */

/** 单个加载来源。判别联合——4 kind 各必填字段，validateSource switch(kind) 穷尽检查。 */
export type ConfigSource =
  | { kind: "explicit"; path: string }
  | { kind: "walk-files"; filenames: string[] }
  | { kind: "walk-dirs"; dirnames: string[] }
  | { kind: "glob"; patterns: string[] };

/** 整份配置（deepMerge 默认值后的结果）。sources 可空数组（零加载）。 */
export interface LoaderConfig {
  sources: ConfigSource[];
}

/**
 * 加载并解析后的单个规则文件记录。去重键 = realPath。
 * sourceId：实现层排序打标字段（收集时按 source 声明序赋值，FR-3.1 全局排序关联）。
 */
export interface RuleFile {
  /** 显示路径（agent 识别用，参与 localeCompare 排序） */
  path: string;
  /** realPath（去重键，realpathSync 规范化） */
  realPath: string;
  /** 内容（frontmatter 已剥离，空内容已过滤） */
  content: string;
  /** globs（来自 frontmatter paths；有则条件规则，无则无条件规则） */
  globs?: string[];
  /** 产出该 rule 的 source 在配置数组的声明序（收集时打标，FR-3.1） */
  sourceId: number;
}

/** validateSource 返回类型。{ok:false} 让 index 无需 try/catch 即分流 notify。 */
export type ValidateResult = { ok: true } | { ok: false; reason: string };

/**
 * dedupAndSort 全局排序元数据。key=sourceId，value={kindRank,declIdx}。
 * kindRank：explicit=0 < walk-files=1 < walk-dirs=2 < glob=3（FR-3.1 优先级源序）。
 * declIdx：声明序（=== key sourceId，显式列出仅为排序元组可读性）。
 */
export type SourceMeta = Map<number, { kindRank: number; declIdx: number }>;

/** 噪声目录排除清单（②D-5，按 basename 匹配，不可变）。防 glob 递归模式在大型项目暴涨。 */
export const NOISE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  "dist",
  "build",
  ".next",
  ".turbo",
  ".cache",
  "out",
]);

/** kind → kindRank 映射（FR-3.1 优先级源序）。供 index 构造 sourceMeta 用。 */
// kindRank：数值越小优先级越高。explicit(0) > walk-files(1) > walk-dirs(2) > glob(3)。
// 显式命名常量替代 magic number，对应 FR-3.1 优先级源序。
const EXPLICIT_KIND_RANK = 0;
const WALK_FILES_KIND_RANK = 1;
const WALK_DIRS_KIND_RANK = 2;
const GLOB_KIND_RANK = 3;

export function kindRankOf(kind: ConfigSource["kind"]): number {
  switch (kind) {
    case "explicit":
      return EXPLICIT_KIND_RANK;
    case "walk-files":
      return WALK_FILES_KIND_RANK;
    case "walk-dirs":
      return WALK_DIRS_KIND_RANK;
    case "glob":
      return GLOB_KIND_RANK;
  }
}
