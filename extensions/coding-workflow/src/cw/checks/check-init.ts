/**
 * coding-init 基建诊断（非阻断软 gate）。
 *
 * 移植自 skills/coding-init/scripts/check_init.py。
 * 入参：projectRoot（项目根——不是 topicDir；与其它 check 脚本签名不同）。
 *
 * 与其它 check_{phase}.ts 的本质区别（这是唯一的「软 gate」）：
 *   - 其它脚本是「硬 gate」——FAIL 则 review 必须 CHANGES_REQUESTED，阻断流程
 *   - 本脚本是「诊断」——永远 passed:true（即使有 FAIL 诊断项），
 *     [STALE]/MISSING/SKELETON 都只是提示，不阻断
 *
 * 因此 toOutput 后强制覆写 passed:true，且不写 changes/machine-check-{phase}.md
 * （init 不绑 review gate），改为写项目级 .xyz-harness/_bootstrap-check.md。
 *
 * 两类检查：
 *   A 长期文档存在性 + 骨架态识别（对照 SKILL.md 文档分级表）
 *   B 回读一致性（仅 ARCHITECTURE/NFR 非骨架态时跑；骨架态跳过——无内容可核对）
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  type CheckOutput,
  CheckReport,
  iterSourceFiles,
  readText,
} from "./shared.js";

// ── 骨架判定（ASCII-only 占位符） ─────────────────────────────
//
// 故意只匹配 ASCII 占位符（{{var}}/{snake_case}/TODO/TBD/FIXME/XXX），
// 不匹配中文占位符（如 ARCHITECTURE.md「[from: {主题}]」里的「{主题}」）。
// 取舍：已沉淀文档也常含中文占位残留，纳入会误判为骨架。
// 代价：纯中文占位符的骨架文档会被判「已沉淀」并跑回读——但回读有自纠错：
// 模块名非 ASCII 会被 _ASCII_IDENT_RE 跳过，不会误报 STALE。
//
// 注意：不复用 shared.checkNoPlaceholders——它的正则虽同形但语义不同
// （硬 gate 判 FAIL），这里需要独立的骨架态判定函数。
const PLACEHOLDER_RE =
  /\{\{[^}]+\}\}|\{[a-zA-Z_][a-zA-Z0-9_.\-]*\}|\b(TODO|TBD|FIXME|XXX)\b/;

/** 内容是否仍是未填充骨架（含 ASCII 占位符）。 */
function isSkeletonContent(content: string): boolean {
  return PLACEHOLDER_RE.test(content);
}

/** 文件是否仍是未填充骨架（读文件后判内容）。 */
function isSkeletonFile(path: string): boolean {
  const content = readText(path);
  if (!content) return false;
  return isSkeletonContent(content);
}

// ── 文档分组（与 SKILL.md「文档清单与分级」表一致） ──────────
//
// [组名, 候选文件名, 级别, 是否 always-current 回读对象]
// 主配置组内任一存在即 OK（CLAUDE.md/AGENTS.md 二选一）。
interface DocGroup {
  name: string;
  candidates: readonly string[];
  level: "必备" | "推荐" | "可选";
  alwaysCurrent: boolean;
}

const DOC_GROUPS: readonly DocGroup[] = [
  { name: "主配置", candidates: ["CLAUDE.md", "AGENTS.md"], level: "必备", alwaysCurrent: false },
  { name: "README.md", candidates: ["README.md"], level: "必备", alwaysCurrent: false },
  { name: "CONTEXT.md", candidates: ["CONTEXT.md"], level: "必备", alwaysCurrent: false },
  { name: "ARCHITECTURE.md", candidates: ["ARCHITECTURE.md"], level: "推荐", alwaysCurrent: true },
  { name: "PRODUCT.md", candidates: ["PRODUCT.md"], level: "推荐", alwaysCurrent: false },
  { name: "NFR.md", candidates: ["NFR.md"], level: "推荐", alwaysCurrent: true },
  { name: "TEST-STRATEGY.md", candidates: ["TEST-STRATEGY.md"], level: "可选", alwaysCurrent: false },
  { name: "DESIGN-LOG.md", candidates: ["DESIGN-LOG.md"], level: "可选", alwaysCurrent: false },
];

// ── 回读提取正则 ─────────────────────────────────────────────

// Mermaid stateDiagram 转换行：A --> B（过滤 [*]/note/direction 等非状态词）
const STATE_TRANSITION_RE = /^\s*(\w+)\s*-->\s*(\w+)/;
const STATE_BLACKLIST = new Set(["note", "direction", "state", "left", "right", "up", "down"]);

// 「验证」字段值中的反引号标识符：`foo` / `Bar.baz()`
const BACKTICK_ID_RE = /`([A-Za-z_][\w.]*)`/g;
// 可字面匹配的模块名：纯 ASCII 标识符（中文/含空格跳过——机器不可靠验证）
const ASCII_IDENT_RE = /^[A-Za-z][A-Za-z0-9_\-]{1,}$/;

// ── 主流程 ───────────────────────────────────────────────────

/**
 * coding-init 基建诊断（软 gate）。
 *
 * @param projectRoot 项目根（主配置 / 长期文档所在层的父目录）
 * @returns CheckOutput——**永远 passed:true**（软 gate 语义，非阻断诊断）
 */
export function runCheckInit(projectRoot: string): CheckOutput {
  const report = new CheckReport("init");
  const docRoot = resolveDocRoot(projectRoot);

  // A 类：长期文档存在性 + 骨架态
  checkDocExistence(report, docRoot);

  // B 类：回读一致性（需源码缓存；iterSourceFiles 跳 node_modules/dist/.git）
  const sourceCache = buildSourceCache(projectRoot);
  checkReadback(report, docRoot, sourceCache);

  // 软 gate：toOutput 后强制 passed:true——[STALE]/MISSING/SKELETON 都不阻断
  const output = report.toOutput({ writeReport: false });

  // 写项目级诊断报告（非 topic 级 changes/——init 是项目级阶段）
  writeBootstrapReport(projectRoot, report, docRoot);

  return { ...output, passed: true };
}

// ── 文档根定位 ───────────────────────────────────────────────

/**
 * 文档根 = 主配置（AGENTS/CLAUDE）所在目录；缺失则回退项目根。
 * 只扫项目根本身（不递归）——深度定位是主 agent 的职责。
 */
function resolveDocRoot(projectRoot: string): string {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    if (isFile(join(projectRoot, name))) return projectRoot;
  }
  return projectRoot;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ── A 类：文档存在性 + 骨架态 ────────────────────────────────

function checkDocExistence(report: CheckReport, docRoot: string): void {
  for (const group of DOC_GROUPS) {
    let existing: string | null = null;
    for (const cand of group.candidates) {
      if (isFile(join(docRoot, cand))) {
        existing = cand;
        break;
      }
    }
    const label = `${group.name}（${group.level}）`;
    if (existing === null) {
      report.addFail(label, `缺失（${group.level}）`);
      continue;
    }
    const p = join(docRoot, existing);
    if (isSkeletonFile(p)) {
      report.addFail(label, `${existing}：含未替换占位符（骨架态）`);
    } else {
      report.addPass(label, `${existing}：已沉淀`);
    }
  }
}

// ── B 类：回读一致性 ─────────────────────────────────────────

/**
 * 预读所有源码到内存，供多次字面匹配复用。
 * iterSourceFiles 已跳 node_modules/dist/.git，字面 in 匹配比逐次 grep 快。
 */
function buildSourceCache(projectRoot: string): string[] {
  const cache: string[] = [];
  for (const fp of iterSourceFiles(projectRoot)) {
    cache.push(readText(fp));
  }
  return cache;
}

/** token 是否在源码缓存中出现（字面匹配）。 */
function searchSource(cache: readonly string[], token: string): boolean {
  return cache.some((c) => c.includes(token));
}

function checkReadback(
  report: CheckReport,
  docRoot: string,
  sourceCache: readonly string[],
): void {
  for (const group of DOC_GROUPS) {
    if (!group.alwaysCurrent) continue;
    for (const cand of group.candidates) {
      const p = join(docRoot, cand);
      if (!isFile(p)) {
        report.addSkip(`回读 ${cand}`, "缺失，跳过回读");
        continue;
      }
      if (isSkeletonFile(p)) {
        report.addSkip(`回读 ${cand}`, "骨架态（含占位符），跳过回读——无内容可核对");
        continue;
      }
      // 非骨架态：做回读
      if (cand === "ARCHITECTURE.md") {
        readbackArchitecture(report, p, sourceCache);
      } else {
        readbackNfr(report, p, sourceCache);
      }
    }
  }
}

/** ARCHITECTURE 回读：模块名 + 状态机枚举 vs 源码。 */
function readbackArchitecture(
  report: CheckReport,
  archPath: string,
  cache: readonly string[],
): void {
  const content = readText(archPath);

  // 1. 模块名（「模块划分」表第 1 列）
  const modules = extractArchitectureModules(content);
  let checked = 0;
  const staleModules: string[] = [];
  const skippedModules: string[] = [];
  for (const mod of modules) {
    if (!ASCII_IDENT_RE.test(mod)) {
      // 中文/含空格模块名——机器不可靠验证（代码标识符是 ASCII）
      skippedModules.push(mod);
      continue;
    }
    checked += 1;
    if (!searchSource(cache, mod)) staleModules.push(mod);
  }
  if (checked > 0 && staleModules.length > 0) {
    report.addFail(
      "回读 ARCHITECTURE.md 模块",
      `模块未在源码找到: ${JSON.stringify(staleModules)}`,
    );
  } else if (checked > 0) {
    report.addPass("回读 ARCHITECTURE.md 模块", `模块全部命中（${checked} 个）`);
  } else if (skippedModules.length > 0) {
    report.addSkip(
      "回读 ARCHITECTURE.md 模块",
      `模块名非 ASCII 标识符，跳过: ${JSON.stringify(skippedModules)}`,
    );
  }

  // 2. 状态机枚举（「关键状态机」mermaid A --> B）
  const states = extractStateMachineStates(content);
  if (states.size > 0) {
    const staleStates = [...states].filter((s) => !searchSource(cache, s));
    if (staleStates.length > 0) {
      report.addFail(
        "回读 ARCHITECTURE.md 状态机",
        `状态机状态未在源码找到: ${JSON.stringify(staleStates.sort())}`,
      );
    } else {
      report.addPass("回读 ARCHITECTURE.md 状态机", `状态全部命中（${states.size} 个）`);
    }
  }
}

/** NFR 回读：约束「验证」字段反引号标识符 vs 源码。 */
function readbackNfr(
  report: CheckReport,
  nfrPath: string,
  cache: readonly string[],
): void {
  const content = readText(nfrPath);
  const verMap = extractNfrVerificationIds(content);
  if (Object.keys(verMap).length === 0) {
    report.addSkip(
      "回读 NFR.md",
      "无含反引号标识符的「验证」字段，跳过（机器无法验证纯文本/基线 ID）",
    );
    return;
  }
  const staleConstraints: Array<[string, string[]]> = [];
  let okCount = 0;
  for (const [cid, ids] of Object.entries(verMap)) {
    // 全部标识符都命不中 = 漂移信号强（验证指向的代码符号全不在）
    if (!ids.some((i) => searchSource(cache, i))) {
      staleConstraints.push([cid, ids]);
    } else {
      okCount += 1;
    }
  }
  if (staleConstraints.length > 0) {
    const details = staleConstraints.map(([cid, ids]) => `${cid}→${JSON.stringify(ids)}`).join("; ");
    report.addFail("回读 NFR.md", `约束验证标识符未在源码找到: ${details}`);
  } else {
    report.addPass("回读 NFR.md", `约束验证标识符全部命中（${okCount} 个约束）`);
  }
}

// ── 回读提取辅助 ─────────────────────────────────────────────

/** 提取匹配 headingPattern 的 ## 章节内容（到下一个 ## 之间）。 */
function extractSectionContent(content: string, headingPattern: string): string {
  const lines = content.split(/\r?\n/);
  const pattern = new RegExp(headingPattern);
  let collecting = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      if (collecting) break; // 遇到下一个 ##，结束
      if (pattern.test(line)) collecting = true;
      continue;
    }
    if (collecting) out.push(line);
  }
  return out.join("\n");
}

/** 提取「模块划分」表第 1 列模块名。 */
function extractArchitectureModules(content: string): string[] {
  const section = extractSectionContent(content, "模块划分");
  if (!section) return [];
  const names: string[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|") || line.includes("---")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // cells[0] 空（首尾 |），cells[1] 第一列；表格至少 2 个 cell（首空 + 一列）
    const MIN_TABLE_CELLS = 2;
    if (cells.length >= MIN_TABLE_CELLS) {
      const name = cells[1];
      if (name && name !== "模块") names.push(name); // 跳表头
    }
  }
  return names;
}

/** 提取「关键状态机」Mermaid 图的状态名（A --> B 转换两端）。 */
function extractStateMachineStates(content: string): Set<string> {
  const section = extractSectionContent(content, "关键状态机");
  if (!section) return new Set();
  const states = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    const m = line.match(STATE_TRANSITION_RE);
    if (m) {
      for (const s of [m[1]!, m[2]!]) {
        if (!STATE_BLACKLIST.has(s.toLowerCase())) states.add(s);
      }
    }
  }
  return states;
}

/**
 * 提取每个 NFR 约束「验证」字段中的反引号代码标识符。
 *
 * 返回 { constraint_id: [identifier, ...] }。无反引号标识符的约束不出现
 * （机器无法验证纯描述性文本/基线 ID，保守跳过）。
 */
function extractNfrVerificationIds(content: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  // 按 ### 约束标题分块
  const blocks = content.split(/\n(?=###\s+[SDPCRV]O?-\d+)/);
  for (const block of blocks) {
    const titleM = block.match(/^###\s+([SDPCRV]O?-\d+)/);
    if (!titleM?.[1]) continue;
    const cid = titleM[1];
    // 找该块的「验证」字段行
    const verM = block.match(/^-\s*\*\*验证\*\*[：:](.+)$/m);
    if (!verM?.[1]) continue;
    const ids = [...verM[1].matchAll(BACKTICK_ID_RE)].map((m) => m[1]!);
    if (ids.length > 0) result[cid] = ids;
  }
  return result;
}

// ── 诊断报告（项目级 .xyz-harness/_bootstrap-check.md） ──────

/** 渲染并写项目级诊断报告。写入失败不阻断（软 gate，诊断失败也不影响流程）。 */
function writeBootstrapReport(
  projectRoot: string,
  report: CheckReport,
  docRoot: string,
): void {
  try {
    const harnessDir = join(projectRoot, ".xyz-harness");
    if (!existsSync(harnessDir)) mkdirSync(harnessDir, { recursive: true });
    const reportPath = join(harnessDir, "_bootstrap-check.md");
    writeFileSync(reportPath, renderBootstrapMarkdown(report, docRoot), "utf8");
  } catch (e) {
    // 诊断报告写入失败不阻断主流程（软 gate 语义）
    void e;
  }
}

/** 渲染诊断 markdown（含 frontmatter + 长期文档表 + 回读块）。 */
function renderBootstrapMarkdown(report: CheckReport, docRoot: string): string {
  // CheckReport 内部 checks 不暴露，借用 verdictLine + render（render 已含表格）。
  // render 用硬 gate 措辞，这里改写头尾为软 gate 诊断语义。
  const lines: string[] = [
    "---",
    "phase: init",
    "mode: diagnostic",
    "---",
    "",
    "# 基建诊断报告 — coding-init",
    "",
    `> **非阻断诊断**。文档根：\`${docRoot}\`。`,
    "> `[STALE]` = 回读不一致（漂移信号），需主 agent 显式告知用户但不阻止流程。",
    "> `MISSING` = 必备文档缺失；`SKELETON` = 仍是未填充骨架。",
    "",
  ];
  // 复用 CheckReport.render() 的检查项表格，剥离其 frontmatter/标题/尾注
  const rendered = report.render();
  const bodyStart = rendered.indexOf("| 检查项 |");
  if (bodyStart >= 0) {
    const table = rendered.slice(bodyStart).split("\n\n")[0] ?? "";
    lines.push(table);
  }
  lines.push("");
  lines.push(
    "> ℹ️ 本诊断永远 passed:true（软 gate）。表中 FAIL/SKIP 项仅作漂移提示，不阻断流程。",
  );
  return lines.join("\n");
}
