/**
 * plan.md E2E 表解析器（纯函数）。
 *
 * 解析 test-case-schema.md 定义的 E2E 用例表格式：
 *
 *   | 用例ID | 场景 | 测试层 | 前置 | 步骤 | 预期 | 执行方式 |
 *   | E1     | ...  | mock   | ...  | 1... | url=/profile,显示用户名 | ... |
 *
 * 输出 TestCase[]（status=pending）。expected 列用 key=value 语法解析为
 * Expected 对象（第一版只认 url= / text=）。
 *
 * 纯函数：只依赖入参（markdown 文本），无 fs / 无 Pi 运行时，可独立单测。
 * 调用方（tool handler）负责读文件后传入文本。
 *
 * 解析规则参考 check_plan.py 的 _parse_wave_table / check_test_machine_judgable
 * （同库的 plan 解析模式，保持一致）。
 */

import { type Expected, type TestCase } from "./state.js";

// ── 章节定位 ─────────────────────────────────────────────────

/** E2E 章节的 heading 正则（与 check_plan.py REQUIRED_SECTIONS 一致）。 */
const E2E_HEADING = /^#{1,6}\s*E2E\s*用例清单|^#{1,6}\s*E2E\s*清单/m;

/** 下一章节 heading（用于截断 extractSection）。 */
const NEXT_HEADING = /^#{1,6}\s/m;

// ── 表格行解析 ───────────────────────────────────────────────

/** 表头关键词（识别并跳过）。 */
const HEADER_FIRST_CELL = /^(用例id|用例\s*id|id|e)$/i;

/** 分隔行（|---|---|）。 */
const SEPARATOR_ROW = /^[\s|-]+$/;

/** 用例 ID 模式（E + 数字 + 可选 -r 后缀）。 */
const CASE_ID = /^E\d+(-r)?$/i;

/** E2E 表最小有效列数（用例ID + 场景 + 测试层 + 前置 + 步骤 + 预期 + 执行方式 = 7，宽松下限 4）。 */
const MIN_TABLE_COLUMNS = 4;

/** 错误信息中预期列原文的截断长度。 */
const ERROR_VALUE_TRUNCATE = 40;

// ── 公共 API ─────────────────────────────────────────────────

/** 解析结果。errors 非空时 cases 可能为空或部分——调用方决定是否 throw。 */
export interface ParseResult {
  cases: TestCase[];
  /** 解析告警/错误（不阻断，由调用方决定如何处理）。 */
  errors: string[];
}

/**
 * 从 plan.md 文本解析 E2E 用例表。
 *
 * @param markdown plan.md 全文
 * @returns ParseResult（cases 全部 status=pending）
 */
export function parseE2ECases(markdown: string): ParseResult {
  const section = extractSection(markdown);
  if (!section) {
    return { cases: [], errors: ["E2E 用例清单章节未找到"] };
  }

  const rows = parseTableRows(section);
  if (rows.length === 0) {
    return { cases: [], errors: ["E2E 章节无可解析的用例行"] };
  }

  const cases: TestCase[] = [];
  const errors: string[] = [];

  for (const cells of rows) {
    const parsed = parseRow(cells);
    if ("error" in parsed) {
      errors.push(parsed.error);
      continue;
    }
    cases.push(parsed.case);
  }

  return { cases, errors };
}

// ── 内部：章节抽取 ───────────────────────────────────────────

/**
 * 抽取 E2E 用例清单章节内容（到下一同级或更高级 heading 前）。
 * 与 check_plan.py 的 extract_section 同模式。
 */
function extractSection(markdown: string): string | undefined {
  const match = E2E_HEADING.exec(markdown);
  if (!match) return undefined;

  const start = match.index + match[0].length;
  const rest = markdown.slice(start);
  const nextMatch = NEXT_HEADING.exec(rest);
  const end = nextMatch ? nextMatch.index : rest.length;
  return rest.slice(0, end);
}

// ── 内部：表格行 ─────────────────────────────────────────────

/** 解析章节里的表格数据行（跳过表头 + 分隔行），返回 cell 数组列表。 */
function parseTableRows(section: string): string[][] {
  const rows: string[][] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const cells = splitRowCells(trimmed);
    if (cells.length < MIN_TABLE_COLUMNS) continue;

    const first = cells[0];
    if (SEPARATOR_ROW.test(trimmed)) continue;
    if (HEADER_FIRST_CELL.test(first)) continue;
    if (!CASE_ID.test(first)) continue;

    rows.push(cells);
  }
  return rows;
}

/** 按 | 切分表格行，去首尾空 cell，trim 每个 cell。 */
function splitRowCells(line: string): string[] {
  return line
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

// ── 内部：单行 → TestCase ───────────────────────────────────

/** E2E 表列序（test-case-schema.md 定义）。 */
const COL = {
  id: 0,
  scenario: 1,
  layer: 2,
  preconditions: 3,
  steps: 4,
  expected: 5,
  executor: 6,
} as const;

type RowResult = { case: TestCase } | { error: string };

/** 把一行 cell 数组解析成 TestCase 或错误信息。 */
function parseRow(cells: string[]): RowResult {
  const id = cells[COL.id];
  const layer = parseLayer(cells[COL.layer]);
  if (!layer) {
    return { error: `${id}: 测试层列非 mock/real（"${cells[COL.layer]}"）` };
  }

  const expectedRaw = cells[COL.expected] ?? "";
  const expected = parseExpected(expectedRaw);
  if (!hasAnyField(expected)) {
    return { error: `${id}: 预期列无 url=/text= 可判定字段（"${truncate(expectedRaw, ERROR_VALUE_TRUNCATE)}"）` };
  }

  return {
    case: {
      id,
      layer,
      scenario: cells[COL.scenario] ?? "",
      preconditions: cells[COL.preconditions] ?? "",
      steps: cells[COL.steps] ?? "",
      expected,
      executor: cells[COL.executor] ?? "",
      status: "pending",
    },
  };
}

/** 解析测试层列。非 mock/real → undefined（报错）。 */
function parseLayer(raw: string): "mock" | "real" | undefined {
  const lower = raw.toLowerCase().trim();
  if (lower === "mock") return "mock";
  if (lower === "real") return "real";
  return undefined;
}

// ── 内部：Expected 解析（核心防谎报机制） ────────────────────

/**
 * 解析「预期」列为 Expected 对象。
 *
 * 支持的语法（第一版）：
 *   - `url=/profile`        → { url: "/profile" }
 *   - `text=用户名`          → { text: "用户名" }
 *   - `url=/profile, text=用户名` → { url: "/profile", text: "用户名" }
 *
 * 不识别的 key= 一律忽略（未来扩展 domAttr 时在此加）。
 * 完全无 key= 语法的文本（如纯描述「跳转到首页」）→ 空 Expected（不可判定，报错）。
 *
 * DESIGN NOTE — 为什么用 key= 语法而非自由文本解析：
 *   自由文本（「跳转/profile，显示用户名」）需要 NLP 猜测哪个词是 url 哪个是
 *   断言，不可靠且是谎报温床。强制 key= 让 plan 作者显式声明可判定字段，
 *   check_plan.py 可同时校验格式，test-orchestrator 解析零歧义。
 */
export function parseExpected(raw: string): Expected {
  const expected: Expected = {};
  // 匹配 key=value，value 到下一个 `, key=` 或行尾
  // key 限定 url/text（白名单），value 可含任意非逗号字符
  const pattern = /\b(url|text)\s*=\s*([^,]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1].toLowerCase() as "url" | "text";
    const value = match[2].trim();
    if (value) {
      expected[key] = value;
    }
  }
  return expected;
}

/** Expected 是否至少有一个可判定字段（无则不可机器判定）。 */
function hasAnyField(expected: Expected): boolean {
  return expected.url !== undefined || expected.text !== undefined;
}

/** 截断文本（错误信息用）。 */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}...`;
}
