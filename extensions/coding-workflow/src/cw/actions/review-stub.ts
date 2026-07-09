/**
 * review-stub 预检（#7 AC-7.1）。
 *
 * mid clarify/detail gate 复用 full-* 的 check_*.py，后者期望 changes/review-{slug}.md
 * 存在且 verdict: APPROVED（由 skill 阶段 review-fix-loop 落盘）。若 review 桩缺失，
 * check_*.py 输出业务 FAIL，但 verdict 行（`machine check: N/M passed → FAIL`）不告诉
 * agent 「缺哪个 review 文件」——agent 困惑（不知是设计问题还是流程缺失）。
 *
 * 本模块在 gate 前 预检 review 桩是否存在，缺失则让 action 直接返结构化 hint
 * （明确指出缺哪个文件 + 下一步跑 review-fix-loop），不跑 gate（#7 方案 A：不造假桩）。
 *
 * 关联：issues.md #7；system-architecture §5.2 review 桩机制。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * 扫 topicDir/changes/ 下指定 slug 的 review 桩，返回缺失的文件名列表。
 *
 * @param topicDir topic 目录（changes/ 的父目录）
 * @param slugs review 桩 slug 数组（如 ["clarity","architecture"]）
 * @returns 缺失的文件名数组（如 ["review-clarity.md"]）；全在则空数组
 */
export function findMissingReviewStubs(topicDir: string, slugs: readonly string[]): string[] {
  const missing: string[] = [];
  for (const slug of slugs) {
    const filename = `review-${slug}.md`;
    if (!existsSync(join(topicDir, "changes", filename))) {
      missing.push(filename);
    }
  }
  return missing;
}

/**
 * 构造「review 桩缺失」的结构化 hint 文本（mustFix 字段用）。
 * agent 拿此 hint 即可理解：缺哪个文件 + 下一步做什么（跑 review-fix-loop）。
 */
export function reviewStubHint(missing: readonly string[]): string {
  return (
    `review 桩文件缺失：${missing.join(", ")}。` +
    `这些文件由 skill 阶段的 review-fix-loop 落盘（verdict: APPROVED），CW 不自动生成。` +
    `请先跑对应 skill 的 review-fix-loop 收敛后落盘 review 文件，再重新调本 action。`
  );
}

/** clarify gate 前置的 review 桩 slug（check_clarity + check_architecture）。 */
export const CLARIFY_REVIEW_SLUGS = ["clarity", "architecture"] as const;

/** detail gate 前置的 review 桩 slug（check_issues + check_nfr + check_code_arch + check_execution）。 */
export const DETAIL_REVIEW_SLUGS = ["issues", "nfr", "code-arch", "execution"] as const;
