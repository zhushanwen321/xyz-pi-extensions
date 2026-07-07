/**
 * coding-execute 执行收尾机器强制门（移植自 skills/coding-execute/scripts/check_execute.py）。
 *
 * 本函数不在 CW GATE_REGISTRY 里——check_execute.py 是 coding-execute skill 内部
 * 自检脚本（对齐 lite-plan 的 check_plan.py）。移植为独立 TS 函数，供 skill/agent 直接
 * 调用，仍按统一 CheckOutput 返回。
 *
 * 签名差异：python argv[1]=plan.md + argv[2]=test-results.json（缺一 exit 2）；
 * TS 改为 runCheckExecute(planPath, resultsPath?)，resultsPath 缺失时降级为 infraError。
 *
 * 职责：读 plan.md 提取用例 ID + 测试层（mock/real，lite U* 与 E* 用例、mid T{UC}.{N} 自适应），
 * 读 test-results.json 逐条比对。mock 层必须 pass；real 层 pass 或 user-skipped（须带
 * 非空 user_confirm_ref 字符串，null/list 蒙混全堵死）。
 * 三条逃逸路径防护：① 缺用例 → FAIL；② AI 自标 manual → FAIL；③ AI 自标 blocked → FAIL。
 *
 * ⚠️ 与 cw 状态机的关系（ADR-029 后两套独立机制）：
 * - **cw 状态机**（store.ts test_case.status）：ADR-029 决策 5 简化为 pass/fail/user-skipped，
 *   砍了 pending-env。workflow agent 渐进式调 cw(test) 写入。
 * - **本机器门**（check-execute.ts 读 test-results.json）：是遗留的「执行收尾」独立门，
 *   不读 cw DB，直接读 test-runner 落盘的 test-results.json。它防御性拒绝 blocked/manual
 *   （两者都不是合法终态）——这不是与 D5 矛盾，而是 test-results.json 层的额外防护。
 *   ADR-029 后 workflow 场景下 test-results.json 可能不再统一落盘（渐进式 cw 取代），
 *   但本门仍服务于非 workflow 场景（手动执行、回退路径）。
 */

import { existsSync, readFileSync } from "node:fs";

import {
  CheckReport,
  extractSection,
  type CheckOutput,
} from "./shared.js";

// mock 层唯一合法 status（单测/mock E2E 必须真跑通过）
const MOCK_OK = new Set(["pass"]);
// 表头/分隔行的占位（解析时跳过）—— 与 python _HEADER_RE 对齐（re.IGNORECASE）
const HEADER_RE = /用例\s*ID|用例id|用例\s*编号/i;
// mid/full 格式的测试执行层 → real 映射。unit 是隔离层（mock），
// integration/e2e/perf-chaos/perf/chaos 都涉及真实集成/环境（real）。
const MID_LAYER_REAL = new Set(["integration", "e2e", "perf-chaos", "perf", "chaos"]);

interface ResultItem {
  id?: unknown;
  status?: unknown;
  user_confirm_ref?: unknown;
  [k: string]: unknown;
}

/**
 * 移植自 check_execute.py main()。
 *
 * @param planPath    plan.md / execution-plan.md 路径
 * @param resultsPath test-results.json 路径（可选；缺失则降级为 infraError）
 * @returns CheckOutput（passed/report/infraError）
 */
export function runCheckExecute(planPath: string, resultsPath?: string): CheckOutput {
  const report = new CheckReport("execute");

  if (!existsSync(planPath)) {
    report.addFail("plan.md 存在", `文件不存在: ${planPath}`);
    return report.toOutput({ writeReport: false });
  }
  report.addPass("plan.md 存在", planPath);

  // resultsPath 缺失：降级（不读文件、不抛）。附 infraError 让调用方知情。
  // toOutput 无 infraError 形参，这里手动构造降级 CheckOutput。
  if (!resultsPath) {
    return {
      passed: false,
      report: report.verdictLine(),
      infraError: "resultsPath 未提供（test-runner 须落盘 test-results.json 后调用）",
    };
  }
  if (!existsSync(resultsPath)) {
    report.addFail("test-results.json 存在", `文件不存在: ${resultsPath}`);
    return report.toOutput({ writeReport: false });
  }
  report.addPass("test-results.json 存在", resultsPath);

  // 提取 plan 用例清单（两种格式：lite plan.md / mid execution-plan.md）
  const uIds = parseUnitCases(planPath);      // lite: U*
  let eCases = parseE2eCases(planPath);        // lite: E*（含测试层）
  const midCases = parseMidManifest(planPath); // mid: T{UC}.{N}（含测试执行层）

  let planFormat: "lite" | "mid";
  let allIds: Set<string>;
  if (Object.keys(midCases).length > 0 && uIds.size === 0 && Object.keys(eCases).length === 0) {
    // mid/full execution-plan.md 格式
    planFormat = "mid";
    eCases = midCases; // 复用 eCases 的 mock/real 比对路径
    allIds = new Set(Object.keys(midCases));
  } else {
    planFormat = "lite";
    allIds = new Set<string>([...uIds, ...Object.keys(eCases)]);
  }

  if (allIds.size === 0) {
    report.addFail(
      "用例清单非空",
      "plan.md 未解析到任何用例（lite: 单测/E2E 章节无表格行？mid: 无测试验收清单章节？）",
    );
    return report.toOutput({ writeReport: false });
  }

  if (planFormat === "mid") {
    const mockCount = Object.values(midCases).filter((v) => v === "mock").length;
    const realCount = Object.values(midCases).filter((v) => v === "real").length;
    report.addPass(
      "用例清单解析",
      `测试验收清单 ${allIds.size} 条（mock(unit)=${mockCount} real(integration/e2e/perf)=${realCount}）`,
    );
  } else {
    const mockCount = Object.values(eCases).filter((v) => v === "mock").length;
    const realCount = Object.values(eCases).filter((v) => v === "real").length;
    report.addPass(
      "用例清单解析",
      `单测 ${uIds.size} 条（mock 层）+ E2E ${Object.keys(eCases).length} 条（mock=${mockCount} real=${realCount}）`,
    );
  }

  const { byId, dupIds } = loadResults(resultsPath, report);

  // test-runner 不应产出重复 id（后者静默覆盖前者会掩盖失败）
  if (dupIds.length > 0) {
    report.addFail(
      "test-results 无重复 id",
      `${dupIds.length} 个 id 重复: ${JSON.stringify([...new Set(dupIds)].sort().slice(0, 5))}` +
        `（test-runner 不应产出重复条目，会静默覆盖）`,
    );
  }

  // 逐条比对
  const mockMissing: string[] = [];
  const mockBad: string[] = [];
  const realMissing: string[] = [];
  const realBadManual: string[] = [];   // 逃逸路径②：AI 自标 manual
  const realBadBlocked: string[] = [];  // 逃逸路径③：AI 自标 blocked
  const realBadOther: string[] = [];
  const realUserSkippedNoRef: string[] = [];
  let mockPass = 0;
  let realPass = 0;
  let realUserSkippedOk = 0;

  for (const cid of [...allIds].sort()) {
    // lite: U* 默认 mock（单测本性隔离）；E* 查测试层。
    // mid: T* 全查 eCases（=midCases，含测试执行层映射）。
    const layer = cid.startsWith("U") ? "mock" : (eCases[cid] ?? "mock");
    const res = byId.get(cid);
    if (res === undefined) {
      if (layer === "real") realMissing.push(cid);
      else mockMissing.push(cid);
      continue;
    }
    const status = String(res.status ?? "").trim().toLowerCase();
    // P0 凭证门：user_confirm_ref 只接受非空字符串。
    // None/list/dict 经 String() 会变成 "None"/"[..]"/"{..}" 非空串蒙混——
    // JSON null 是 AI「没真问用户」最自然的值，必须堵死。
    const refRaw = res.user_confirm_ref;
    const ref = typeof refRaw === "string" ? refRaw.trim() : "";

    if (layer === "mock") {
      if (MOCK_OK.has(status)) {
        mockPass += 1;
      } else {
        mockBad.push(`${cid}=${status || "空"}`);
      }
    } else {
      // real
      if (status === "pass") {
        realPass += 1;
      } else if (status === "user-skipped") {
        if (!ref) {
          realUserSkippedNoRef.push(cid);
        } else {
          realUserSkippedOk += 1;
        }
      } else if (status === "manual") {
        realBadManual.push(cid);
      } else if (status === "blocked") {
        realBadBlocked.push(cid);
      } else {
        realBadOther.push(`${cid}=${status || "空"}`);
      }
    }
  }

  // 汇总判定
  if (mockMissing.length > 0) {
    report.addFail("mock 层用例无结果（逃逸路径①）", `${mockMissing.length} 条缺执行结果: ${JSON.stringify(mockMissing.slice(0, 5))}`);
  } else {
    report.addPass("mock 层用例全覆盖", `${mockPass} 条 pass`);
  }
  if (mockBad.length > 0) {
    report.addFail("mock 层非 pass", `${mockBad.length} 条未通过: ${JSON.stringify(mockBad.slice(0, 5))}（mock 层必须真跑 pass）`);
  }
  if (realMissing.length > 0) {
    report.addFail("real 层用例无结果（逃逸路径①）", `${realMissing.length} 条缺执行结果: ${JSON.stringify(realMissing.slice(0, 5))}`);
  } else {
    report.addPass("real 层用例全覆盖", `pass=${realPass} user-skipped=${realUserSkippedOk}`);
  }
  // 逃逸路径②/③ + 凭证门：用表驱动统一记 FAIL（detail 格式：{n} 条: {ids} — {advice}）
  const failBuckets: Array<[string[], string, string]> = [
    [realBadManual, "real 层 AI 自标 manual（逃逸路径②）", "禁止 AI 自决「手动验证通过」；须 ask_user 确认后记 user-skipped+user_confirm_ref"],
    [realBadBlocked, "real 层 AI 自标 blocked（逃逸路径③）", "blocked 不是合法终态；须真跑或 ask_user 确认 user-skipped"],
    [realBadOther, "real 层非法 status", "合法: pass / user-skipped"],
    [realUserSkippedNoRef, "user-skipped 缺凭证", "须记录用户确认引用"],
  ];
  for (const [bucket, name, advice] of failBuckets) {
    if (bucket.length > 0) {
      report.addFail(name, `${bucket.length} 条: ${JSON.stringify(bucket.slice(0, 5))} — ${advice}`);
    }
  }

  // real 层真跑比例提示（不阻塞，兼容无真实环境——P2 合法出路之一）
  const realTotal = Object.values(eCases).filter((v) => v === "real").length;
  if (realTotal > 0 && realPass === 0 && !report.failed) {
    report.addSkip(
      "real 层真跑覆盖",
      `real 用例 ${realTotal} 条全部 user-skipped，无真跑集成验证（用户已确认场景；若项目有真实环境建议至少 1 条真跑）`,
    );
  }

  return report.toOutput({ writeReport: false });
}

// ── plan.md 用例解析（移植自 check_execute.py 的三个 parse_* 函数） ──

/** 行按 | 切分，去空段，返回非空 cells（与 python `s.split("|")` + 过滤 "" 对齐）。 */
function splitRow(line: string): string[] {
  return line
    .split("|")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

/**
 * 提取单测用例 ID 集合（默认 mock 层）。返回 {'U1','U2',...}
 *
 * lite 格式：从「单测用例清单」章节解析 U* ID。
 * 移植自 parse_unit_cases。
 */
function parseUnitCases(mdPath: string): Set<string> {
  const section = extractSection(mdPath, "单测用例清单|单测清单") ?? "";
  const ids = new Set<string>();
  for (const line of section.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("|")) continue;
    if (HEADER_RE.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length === 0) continue;
    const m = cells[0]!.match(/^(U\d+)\b/);
    if (m && m[1]) ids.add(m[1]);
  }
  return ids;
}

/**
 * 提取 E2E 用例 {id: layer}。
 *
 * layer 优先取「测试层」列；列缺失时按 -r 后缀判定（real），否则默认 mock。
 * 返回 {'E1': 'mock', 'E1-r': 'real', ...}
 * 移植自 parse_e2e_cases。
 */
function parseE2eCases(mdPath: string): Record<string, string> {
  const section = extractSection(mdPath, "E2E\\s*用例清单|E2E\\s*清单") ?? "";
  // 定位「测试层」列索引
  let layerCol: number | null = null;
  for (const line of section.split(/\r?\n/)) {
    if (HEADER_RE.test(line)) {
      const cells = splitRow(line);
      for (let idx = 0; idx < cells.length; idx++) {
        const c = cells[idx]!;
        if (c.includes("测试层") || c.includes("层级")) {
          layerCol = idx;
          break;
        }
      }
      break;
    }
  }
  const cases: Record<string, string> = {};
  for (const line of section.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("|")) continue;
    if (HEADER_RE.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    const m = cells[0]!.match(/^(E\d+(?:-r)?)\b/);
    if (!m || !m[1]) continue;
    const caseId = m[1];
    let layer = "mock";
    if (layerCol !== null && layerCol < cells.length) {
      const val = cells[layerCol]!.toLowerCase().trim();
      if (val === "mock" || val === "real") layer = val;
    }
    // -r 后缀强提示 real（即使「测试层」列缺失）
    if (caseId.endsWith("-r")) layer = "real";
    cases[caseId] = layer;
  }
  return cases;
}

/**
 * 提取 mid/full execution-plan.md 的测试验收清单用例。
 *
 * mid 格式：章节「测试验收清单（Test Acceptance Manifest）」，ID 为 T{UC}.{N}，
 * 「测试执行层」列取值 unit/integration/e2e/perf-chaos。
 * 返回 {'T1.1': 'mock', 'T1.3': 'real', ...}（映射到 mock/real 两层）。
 * 移植自 parse_mid_manifest。
 */
function parseMidManifest(mdPath: string): Record<string, string> {
  const section = extractSection(mdPath, "测试验收清单|Test Acceptance") ?? "";
  if (!section) return {};
  // 定位「测试执行层」列索引
  let layerCol: number | null = null;
  for (const line of section.split(/\r?\n/)) {
    const cells = splitRow(line);
    for (let idx = 0; idx < cells.length; idx++) {
      const c = cells[idx]!;
      if (c.includes("测试执行层") || c.includes("执行层")) {
        layerCol = idx;
        break;
      }
    }
    if (layerCol !== null) break;
  }
  const cases: Record<string, string> = {};
  for (const line of section.split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith("|")) continue;
    if (HEADER_RE.test(line)) continue;
    const cells = splitRow(line);
    if (cells.length < 2) continue;
    const m = cells[0]!.match(/^T(\d+\.\d+)\b/);
    if (!m || !m[1]) continue;
    const caseId = "T" + m[1];
    let layer = "mock"; // unit 默认 mock
    if (layerCol !== null && layerCol < cells.length) {
      const val = cells[layerCol]!.toLowerCase().trim();
      if (MID_LAYER_REAL.has(val)) {
        layer = "real";
      } else if (val === "unit") {
        layer = "mock";
      }
    }
    cases[caseId] = layer;
  }
  return cases;
}

/**
 * 读 test-results.json。返回 {byId, dupIds}。
 *
 * 支持顶层为数组，或 {results: [...]} 包裹。
 * json 损坏时记 FAIL 并返回 {byId: empty, dupIds: empty}。
 * 移植自 load_results。
 */
function loadResults(
  jsonPath: string,
  report: CheckReport,
): { byId: Map<string, ResultItem>; dupIds: string[] } {
  let data: unknown;
  try {
    const text = readFileSync(jsonPath, "utf8");
    data = JSON.parse(text);
  } catch (e) {
    report.addFail(
      "test-results.json 解析",
      `文件损坏或非合法 JSON: ${e instanceof Error ? e.message : String(e)}（test-runner 须落盘合法 schema）`,
    );
    return { byId: new Map(), dupIds: [] };
  }

  let items: unknown[];
  if (Array.isArray(data)) {
    items = data;
  } else if (data !== null && typeof data === "object" && "results" in data) {
    const wrapped = (data as { results?: unknown }).results;
    items = Array.isArray(wrapped) ? wrapped : [];
  } else {
    items = [];
  }

  const byId = new Map<string, ResultItem>();
  const dupIds: string[] = [];
  for (const item of items) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as ResultItem;
    const cid = String(obj.id ?? "").trim();
    if (cid) {
      if (byId.has(cid)) {
        dupIds.push(cid);
      }
      byId.set(cid, obj);
    }
  }
  return { byId, dupIds };
}
