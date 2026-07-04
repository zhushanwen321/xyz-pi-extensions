/**
 * full-nfr（④非功能性设计）硬规则机器验证。
 *
 * 移植自 skills/full-nfr/scripts/check_nfr.py。
 * 入参：topicDir（含 non-functional-design.md + changes/review-nfr.md + issues.md）。
 *
 * 检查项：
 *   ①结构性：交付物存在 / verdict:pass / 关键章节 / 无占位符 / review-nfr APPROVED
 *   ②引用：
 *     - 缓解项回灌表每行有「验收方式」列且值 ∈ {代码测试, 骨架约束, 性能混沌, 运维项}
 *     - 无 ❌（不可接受）项残留
 *     - 回灌表「回灌去向=③issue」的行，#N 真实存在于 issues.md（PHANTOM 形式检查）
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { extractRealIssueIds } from "./check-issues.js";
import {
  CheckReport,
  checkFileExists,
  checkFrontmatterVerdict,
  checkNoPlaceholders,
  checkRequiredSections,
  checkReviewVerdict,
  extractSection,
  readText,
  type CheckOutput,
} from "./shared.js";

const DELIVERABLE = "non-functional-design.md";
const VALID_ACCEPTANCE = new Set(["代码测试", "骨架约束", "性能混沌", "运维项"]);

export function runCheckNfr(topicDir: string): CheckOutput {
  const report = new CheckReport("nfr");
  const mdPath = join(topicDir, DELIVERABLE);

  // ① 结构性
  if (!checkFileExists(report, `${DELIVERABLE} 存在`, mdPath)) {
    return report.toOutput({ writeReport: true, topicDir });
  }
  checkFrontmatterVerdict(report, mdPath, "pass");
  checkRequiredSections(report, mdPath, "关键章节", [
    "分析矩阵|风险矩阵",
    "缓解项回灌|Mitigation",
  ]);
  checkNoPlaceholders(report, "无占位符", mdPath);
  checkReviewVerdict(report, topicDir, "nfr", "APPROVED");

  // ② 缓解项回灌表每行有验收方式列且值合法
  const mitigationSection = extractSection(mdPath, "缓解项回灌|Mitigation");
  if (mitigationSection) {
    // 提取表格行（含「验收方式」列，跳过表头和分隔行）
    const tableRows = mitigationSection
      .split(/\r?\n/)
      .filter((l) => l.trim().startsWith("|") && !l.includes("----") && !l.includes("验收方式"));
    if (tableRows.length > 0) {
      const invalidAcceptance: string[] = [];
      for (const row of tableRows) {
        const cells = row.split("|").slice(1, -1).map((c) => c.trim());
        // 找验收方式列（倒数第2列）
        if (cells.length >= 2) {
          const acceptance = cells[cells.length - 2] ?? "";
          const matched = [...VALID_ACCEPTANCE].filter((v) => acceptance.includes(v));
          if (matched.length === 0) {
            invalidAcceptance.push(`'${acceptance}'`);
          }
        }
      }
      if (invalidAcceptance.length > 0) {
        report.addFail(
          "验收方式列合法",
          `${invalidAcceptance.length} 行验收方式不合法: ${JSON.stringify(invalidAcceptance.slice(0, 3))}` +
            `（应 ∈ ${JSON.stringify([...VALID_ACCEPTANCE])}）`,
        );
      } else {
        report.addPass("验收方式列合法", `${tableRows.length} 行缓解项均标了合法验收方式`);
      }
    } else {
      report.addFail("缓解项回灌表", "缓解项回灌章节无表格行");
    }
  } else {
    report.addFail("缓解项回灌表", "无「缓解项回灌登记」章节（MANDATORY）");
  }

  // ② 无 ❌（不可接受）项残留
  const content = readText(mdPath);
  const unacceptable = content.match(/❌[^\n]*/g) ?? [];
  // 过滤掉说明性文字里的 ❌（如"无 ❌ 项"）
  const realUnacceptable = unacceptable.filter((u) => !u.slice(0, 3).includes("无") && !u.includes("不残留"));
  if (realUnacceptable.length > 0) {
    report.addFail(
      "无 ❌ 不可接受项",
      `残留 ${realUnacceptable.length} 处 ❌（不可接受项应已回 Step 3 重选方案）`,
    );
  } else {
    report.addPass("无 ❌ 不可接受项", "无不可接受项残留");
  }

  // ③ 回灌指针 PHANTOM 形式检查
  if (mitigationSection) {
    checkBackfeedPhantom(report, topicDir, mitigationSection);
  }

  return report.toOutput({ writeReport: true, topicDir });
}

/**
 * 回灌指针 PHANTOM 形式检查。
 *
 * 回灌表「回灌去向=③issue」的行，提取 #N，核对是否在 issues.md 的 issue 定义里真实存在。
 * 机器只查 PHANTOM（指针断裂）；MISMATCH（属性不符）+ ORPHAN 靠 Step2 重建器。
 * issues.md 不存在时降级为 SKIP。
 */
function checkBackfeedPhantom(
  report: CheckReport,
  topicDir: string,
  mitigationSection: string,
): void {
  const issuesPath = join(topicDir, "issues.md");
  if (!existsSync(issuesPath)) {
    report.addSkip(
      "回灌③指针 PHANTOM",
      "issues.md 不存在，跳过（MISMATCH/ORPHAN 仍由 Step2 重建器查）",
    );
    return;
  }

  const issuesContent = readText(issuesPath);
  const realIssueIds = new Set(extractRealIssueIds(issuesContent));

  // 从回灌表提取「回灌去向」含 ③/issue 的行里的 #N 引用
  const tableRows = mitigationSection
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith("|") && !l.includes("----"));
  const phantomRefs: string[] = [];
  let checked = 0;
  for (const row of tableRows) {
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    // 跳过「回灌去向」表头行
    if (cells.some((c) => c.includes("回灌去向") || c.includes("去向"))) continue;
    // 只看声明指向 ③ 的行（回灌去向列含「③」或「issue」且含 #N）
    const targets3 = cells.filter(
      (c) => (c.includes("③") || c.toLowerCase().includes("issue")) && /#\d+/.test(c),
    );
    for (const cell of targets3) {
      for (const m of cell.matchAll(/#(\d+)/g)) {
        checked++;
        const ref = m[1]!;
        if (!realIssueIds.has(ref)) {
          phantomRefs.push(`#${ref}`);
        }
      }
    }
  }

  if (phantomRefs.length > 0) {
    report.addFail(
      "回灌③指针 PHANTOM",
      `${phantomRefs.length} 处回灌指针指向不存在的 issue: ${JSON.stringify(phantomRefs.slice(0, 5))}（issues.md 无此编号）`,
    );
  } else if (checked > 0) {
    report.addPass("回灌③指针 PHANTOM", `${checked} 处回灌③指针均指向真实存在的 issue`);
  } else {
    report.addSkip("回灌③指针 PHANTOM", "回灌表无指向 ③issue 的行（可能全去⑤/运维项）");
  }
}
