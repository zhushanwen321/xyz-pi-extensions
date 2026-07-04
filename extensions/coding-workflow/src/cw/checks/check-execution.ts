/**
 * full-execution-plan（⑥执行计划）硬规则机器验证。
 *
 * 移植自 skills/full-execution-plan/scripts/check_execution.py。
 * 入参：topicDir（含 execution-plan.md + changes/review-execution.md）。
 *
 * 检查项：
 *   ①结构性：交付物存在 / verdict:pass / 关键章节 / 无占位符 / review-execution APPROVED
 *           consistency-final.md 存在且 verdict: CONSISTENT（Step 6c 总闸门）
 *   ②引用：测试验收清单用例 ID 集合 == ⑤test-matrix 全量（集合相等）
 *           末尾验收 Wave 存在，blocked_by 含所有功能 Wave
 *
 * 与 python 版差异：忽略 --no-consistency-final（CW gate 总是跑全量，6c 总闸门必检）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  CheckReport,
  checkFileExists,
  checkFrontmatterVerdict,
  checkNoPlaceholders,
  checkRequiredSections,
  checkReviewVerdict,
  extractSection,
  parseFrontmatter,
  readText,
  type CheckOutput,
} from "./shared.js";

const DELIVERABLE = "execution-plan.md";

export function runCheckExecution(topicDir: string): CheckOutput {
  const report = new CheckReport("execution");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性五件套
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }
  checkFrontmatterVerdict(report, mdPath, "pass");
  checkRequiredSections(report, mdPath, "关键章节", [
    "Wave 编排|DAG|调度表",
    "测试验收清单|Test Acceptance",
  ]);
  checkNoPlaceholders(report, "无占位符", mdPath);
  checkReviewVerdict(report, topicDir, "execution", "APPROVED");

  // ① consistency-final.md（Step 6c 总闸门）—— TS 版忽略 --no-consistency-final
  const consistencyPath = join(topicDir, "changes", "consistency-final.md");
  if (existsSync(consistencyPath)) {
    const fm = parseFrontmatter(consistencyPath);
    const verdict = (fm.verdict ?? "").trim();
    if (verdict === "CONSISTENT") {
      report.addPass("consistency-final CONSISTENT", "Step 6c 总闸门通过");
    } else {
      report.addFail(
        "consistency-final CONSISTENT",
        `verdict: '${verdict}'（期望 CONSISTENT）`,
      );
    }
  } else {
    report.addFail(
      "consistency-final 存在",
      "无 changes/consistency-final.md（Step 6c 总闸门）",
    );
  }

  // ② 测试验收清单用例 ID 集合 == ⑤test-matrix 全量（集合相等）
  const manifestSection = extractSection(mdPath, "测试验收清单|Test Acceptance");
  const manifestIds = extractTestIds(manifestSection);

  const codeArchPath = join(topicDir, "code-architecture.md");
  const tmSection = existsSync(codeArchPath)
    ? extractSection(codeArchPath, "测试矩阵|Test Matrix")
    : "";
  const testmatrixIds = extractTestIds(tmSection);

  if (manifestSection) {
    if (testmatrixIds.size > 0) {
      const missing = [...testmatrixIds].filter((id) => !manifestIds.has(id));
      const extra = [...manifestIds].filter((id) => !testmatrixIds.has(id));
      if (missing.length > 0) {
        report.addFail(
          "验收清单 = ⑤test-matrix 全量",
          `清单缺 ${missing.length} 个用例: ${JSON.stringify(missing.slice(0, 5))}`,
        );
      } else if (extra.length > 0) {
        report.addFail(
          "验收清单 = ⑤test-matrix 全量",
          `清单多 ${extra.length} 个用例（⑤无）: ${JSON.stringify(extra.slice(0, 5))}`,
        );
      } else {
        report.addPass(
          "验收清单 = ⑤test-matrix 全量",
          `集合完全相等（${manifestIds.size} 个用例）`,
        );
      }
    } else {
      report.addSkip("验收清单 = ⑤test-matrix 全量", "⑤无 test-matrix，无法比对");
    }
  } else {
    report.addFail("测试验收清单", "无「测试验收清单」章节（MANDATORY）");
  }

  // ② 末尾验收 Wave 存在，blocked_by 含所有功能 Wave
  checkAcceptanceWave(report, mdPath);

  return report.toOutput({ writeReport: true, topicDir });
}

/** 从文本提取所有 T{N}.{M} 用例 ID，返回去重集合。 */
function extractTestIds(text: string): Set<string> {
  const ids = new Set<string>();
  if (!text) return ids;
  for (const m of text.matchAll(/T(\d+\.\d+)/g)) {
    if (m[1]) ids.add(m[1]);
  }
  return ids;
}

/**
 * 检查末尾验收 Wave 存在且 blocked_by 含所有功能 Wave。
 *
 * 移植自 check_execution._check_acceptance_wave：
 *   - 找所有 `## Wave N` 标题 → wave 编号集合
 *   - 验收 Wave（标题含「验收/Acceptance」）必须是最大号
 *   - 验收 Wave 的 blocked_by 须含所有功能 Wave 号
 */
function checkAcceptanceWave(report: CheckReport, mdPath: string): void {
  const content = readText(mdPath);

  // 找所有 Wave 标题（## Wave N，恰好两井号）
  const waveMatches = [...content.matchAll(/##\s*Wave\s*(\d+)[^\n]*/g)];
  if (waveMatches.length === 0) {
    report.addSkip("末尾验收 Wave", "无 Wave 编排（可能未编排）");
    return;
  }
  const waveNums = [...new Set(waveMatches.map((m) => Number(m[1])))].sort(
    (a, b) => a - b,
  );
  const maxWave = waveNums[waveNums.length - 1]!;

  // 找验收 Wave（标题含「验收」或「Acceptance」）—— re.IGNORECASE → i flag
  const accMatch = content.match(
    /##\s*Wave\s*(\d+)[^\n]*(?:验收|Acceptance|验收\s*Gate)[^\n]*/i,
  );
  if (!accMatch || accMatch[1] === undefined) {
    report.addFail(
      "末尾验收 Wave 存在",
      "无「验收 Wave」（标题应含「验收/Acceptance」）",
    );
    return;
  }
  const accNum = Number(accMatch[1]);

  // 验收 Wave 应是最后一个
  if (accNum !== maxWave) {
    report.addFail(
      "验收 Wave 在末端",
      `验收 Wave 是 Wave ${accNum}，但最大 Wave 是 ${maxWave}（验收应最后）`,
    );
    return;
  }

  // functional waves = 除验收 Wave 外的所有（排除 0）
  const functionalWaves = waveNums.filter((w) => w !== accNum && w !== 0);
  if (functionalWaves.length === 0) {
    report.addPass("末尾验收 Wave", `Wave ${accNum} 是验收 Wave`);
    return;
  }

  // 检查验收 Wave 的 blocked_by 含所有功能 Wave
  const accSection = extractSection(
    mdPath,
    `Wave\\s*${accNum}[^\\n]*(?:验收|Acceptance)`,
  );
  let blockedByMatch = (accSection ?? "").match(
    /\**\s*[Bb]locked\s*by\s*\**\s*[:：]\s*([^\n]+)/,
  );
  if (!blockedByMatch) {
    // 兜底：全文找
    blockedByMatch = content.match(
      /\**\s*[Bb]locked\s*by\s*\**\s*[:：]\s*([^\n]+)/,
    );
  }

  if (blockedByMatch && blockedByMatch[1]) {
    // deps：`Wave N` 或 `#N` / 裸 N，取首个非空捕获组
    const depNums = new Set<number>();
    for (const m of blockedByMatch[1].matchAll(/Wave\s*(\d+)|#?(\d+)/g)) {
      const n = m[1] ?? m[2];
      if (n) depNums.add(Number(n));
    }
    const missingDeps = functionalWaves.filter((w) => !depNums.has(w));
    if (missingDeps.length > 0) {
      report.addFail(
        "验收 Wave blocked_by 全功能 Wave",
        `验收 Wave 未 blocked_by 功能 Wave: ${JSON.stringify(missingDeps)}`,
      );
    } else {
      report.addPass(
        "验收 Wave blocked_by 全功能 Wave",
        `blocked_by 全部 ${functionalWaves.length} 个功能 Wave`,
      );
    }
  } else {
    report.addFail(
      "验收 Wave blocked_by 全功能 Wave",
      `验收 Wave 无 blocked_by 声明（应含功能 Wave: ${JSON.stringify(functionalWaves)}）`,
    );
  }
}
