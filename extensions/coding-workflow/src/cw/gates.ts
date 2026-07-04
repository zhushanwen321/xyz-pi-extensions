/**
 * gates — gate 注册表 + 执行器 + subprocess/git adapter（§5 architecture）。
 *
 * 内容：
 *   - GATE_REGISTRY 声明式数组（§5.2 的 11 行表 1:1 编码，#4 方案 A）
 *   - runGate 通用执行器（串行 fail-fast，§5.3）
 *   - lookupGateTier（progressive gate 透传 gateTier 到 gateHistory）
 *   - GateRunner（subprocess adapter，#6，真引 spawnSync 调 check_*.py）
 *   - GitValidator（execFileSync adapter，#3，真引 git 三项校验）
 *
 * Adapter 真引 SDK（Tier 2 证伪）：spawnSync / execFileSync 真调用 + 透传参数，
 * 让 tsc 对 node:child_process 声明验签。
 *
 * 与骨架的分歧（nfr #3 + T2.15 / #6 + T2.21a / T2.19）：
 *   - GitValidator：git ENOENT（可执行文件缺失）→ throw infra-error；commit 无效（非零退出）
 *     → {valid:false} 业务 fail。catch 里按 errno.code === 'ENOENT' 区分。
 *   - GateRunner：topicDir 路径遍历（.. / 绝对路径）→ infraError 拒（不 spawn）；
 *     verdict/exitcode 矛盾 → infraError（T2.21a）；无 verdict 行 → infraError（契约 pin）。
 */

import { execFileSync, spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";

import type { CwAction, CwTopic, GateTier, Tier } from "./types.js";

// ── gate 注册表（#4 方案 A 声明式数组） ──────────────────────

export type Checker = (ctx: GateContext) => CheckerResult;

export interface CheckerResult {
  name: string;
  passed: boolean;
  report?: string;
}

export interface GateRule {
  tier: Tier;
  phase: CwAction;
  checkers: Checker[];
  gateTier: GateTier;
  /** progressive gate（dev/test）：registry 只标 gateTier，action 自跑 checker。 */
  progressive?: boolean;
}

export interface GateContext {
  topic: CwTopic;
  topicDir: string;
  workspacePath: string;
  runner: GateRunner;
  git: GitValidator;
}

export interface GateResult {
  passed: boolean;
  gateTier: GateTier;
  reports: CheckerResult[];
}

/**
 * §5.2 的 11 行表 1:1 编码。checkers 是 in-process 闭包，调 ctx.runner。
 * progressive 行（dev/test）checkers 空——action handler 直接调 GitValidator/judgeByExpected。
 */
function buildChecker(scriptPath: string): Checker {
  return (ctx: GateContext): CheckerResult => {
    const out = ctx.runner.runCheck(scriptPath, ctx.topicDir);
    return { name: scriptPath, passed: out.passed, report: out.report ?? out.infraError };
  };
}

export const GATE_REGISTRY: GateRule[] = [
  // lite
  { tier: "lite", phase: "plan", checkers: [buildChecker("check_plan.py")], gateTier: "weak-structural" },
  { tier: "lite", phase: "dev", checkers: [], gateTier: "medium-git", progressive: true },
  { tier: "lite", phase: "test", checkers: [], gateTier: "strong-recompute", progressive: true },
  { tier: "lite", phase: "retrospect", checkers: [], gateTier: "weak-structural" },
  { tier: "lite", phase: "closeout", checkers: [buildChecker("check_closeout.py")], gateTier: "weak-structural" },
  // mid
  {
    tier: "mid",
    phase: "clarify",
    checkers: [buildChecker("check_clarity.py"), buildChecker("check_architecture.py")],
    gateTier: "weak-structural",
  },
  {
    tier: "mid",
    phase: "detail",
    checkers: [
      buildChecker("check_issues.py"),
      buildChecker("check_nfr.py"),
      buildChecker("check_code_arch.py"),
      buildChecker("check_execution.py"),
    ],
    gateTier: "weak-structural",
  },
  { tier: "mid", phase: "dev", checkers: [], gateTier: "medium-git", progressive: true },
  { tier: "mid", phase: "test", checkers: [], gateTier: "medium-coverage", progressive: true },
  { tier: "mid", phase: "retrospect", checkers: [], gateTier: "weak-structural" },
  { tier: "mid", phase: "closeout", checkers: [buildChecker("check_closeout.py")], gateTier: "weak-structural" },
];

// ── 执行器 ───────────────────────────────────────────────────

/** 查 registry 单条规则。 */
function findRule(tier: Tier, phase: CwAction): GateRule {
  const rule = GATE_REGISTRY.find((r) => r.tier === tier && r.phase === phase);
  if (!rule) {
    throw new Error(`no gate rule for tier=${tier} phase=${phase}`);
  }
  return rule;
}

/**
 * 通用 gate 执行器（single-shot 用，§5.3 串行 fail-fast）。
 *
 * progressive phase（dev/test）不在 runGate 跑 checker——action handler 自跑
 * GitValidator/judgeByExpected（per-item 容错，#3 方案 A）。runGate 对 progressive
 * 只返回 gateTier（gateHistory 透传用）。
 */
export function runGate(ctx: GateContext, tier: Tier, phase: CwAction): GateResult {
  const rule = findRule(tier, phase);
  const reports: CheckerResult[] = [];
  for (const checker of rule.checkers) {
    const r = checker(ctx);
    reports.push(r);
    if (!r.passed) {
      // fail-fast：剩余 checker 不跑（#4 AC-4.2）。
      return { passed: false, gateTier: rule.gateTier, reports };
    }
  }
  return { passed: true, gateTier: rule.gateTier, reports };
}

/** progressive gate 透传 gateTier 到 gateHistory（dev/test action 用）。 */
export function lookupGateTier(tier: Tier, phase: CwAction): GateTier {
  return findRule(tier, phase).gateTier;
}

// ── GateRunner（subprocess adapter，#6） ─────────────────────

export interface CheckOutput {
  passed: boolean;
  report?: string;
  /** crash / timeout / 路径遍历 / 契约矛盾 → infraError（业务 fail vs 基础设施异常，#6 方案 A）。 */
  infraError?: string;
}

// ── subprocess 契约常量（#6，语义化命名） ─────────────────
/** check_*.py subprocess 超时（ms），超时 → kill + infraError（T2.20/T2.21c）。 */
const SUBPROCESS_TIMEOUT_MS = 60_000;
/** python exit code 2 = usage error（infra，见 finalize_and_exit 契约）。 */
const EXIT_USAGE_ERROR = 2;
/** infra 错误消息里 stderr/stdout 片段截断长度（防消息爆炸）。 */
const ERR_FRAGMENT_LEN = 200;

/** topicDir 路径遍历校验（T2.19）：含 .. 段或绝对路径 → true。 */
function hasPathTraversal(p: string): boolean {
  if (isAbsolute(p)) return true;
  const segments = p.split(/[/\\]/);
  return segments.some((s) => s === "..");
}

/**
 * spawnSync 调 python check_*.py，解析 stdout 末行 verdict。
 *
 * 输出契约（_shared_check_lib.finalize_and_exit）：
 *   stdout 末行：`[{phase}] machine check: {passed}/{total} passed → PASS|FAIL`
 *   exit 0 = pass，exit 1 = 业务 fail，exit 2 = usage error（infra）。
 *
 * 三种 infra 场景（T2.21a/b/c）：
 *   - verdict/exitcode 矛盾（exit0+FAIL 或 exit1+PASS）→ infraError
 *   - python ENOENT / crash（status=null）→ infraError
 *   - timeout（SIGTERM）→ infraError
 */
export class GateRunner {
  constructor(private cwd: string) {}

  runCheck(scriptPath: string, topicDir: string): CheckOutput {
    // T2.19：路径遍历在 spawn 前拒（topicDir 由 topicId 派生，正常不含 .. / 绝对路径）。
    if (hasPathTraversal(topicDir)) {
      return {
        passed: false,
        infraError: `path traversal rejected: topicDir="${topicDir}" must be relative without ..`,
      };
    }

    const result = spawnSync("python3", [scriptPath, topicDir], {
      cwd: this.cwd,
      encoding: "utf8",
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    // T2.21b（ENOENT/crash，status=null）/ T2.20·T2.21c（timeout，signal=SIGTERM）。
    if (result.status === null || result.signal) {
      return {
        passed: false,
        infraError: `subprocess ${result.signal ?? "crash"}: ${(result.stderr ?? "").slice(0, ERR_FRAGMENT_LEN)}`,
      };
    }
    // exit 2 = usage error（infra）。
    if (result.status === EXIT_USAGE_ERROR) {
      return { passed: false, infraError: `usage error: ${(result.stderr ?? "").slice(0, ERR_FRAGMENT_LEN)}` };
    }

    // 业务 verdict：解析含 "machine check" 的末行（#6 方案 A 双信号：verdict 行 + exit code）。
    const verdictLine = result.stdout
      .split("\n")
      .filter((l) => l.includes("machine check"))
      .pop();

    if (verdictLine === undefined) {
      // 契约 pin（T2.22）：脚本未输出 verdict 行 → 无法判定 → infraError。
      return {
        passed: false,
        infraError: `no verdict line in stdout: ${(result.stdout ?? "").slice(-ERR_FRAGMENT_LEN)}`,
      };
    }

    const exitPass = result.status === 0;
    const verdictPass = verdictLine.includes("PASS");
    const verdictFail = verdictLine.includes("FAIL");

    // T2.21a：verdict 与 exitcode 矛盾 → infraError（脚本输出不一致，不可信）。
    if ((verdictPass && !exitPass) || (verdictFail && exitPass)) {
      return {
        passed: false,
        infraError: `verdict/exitcode contradiction: verdict="${verdictPass ? "PASS" : verdictFail ? "FAIL" : "?"}" exit=${result.status}: ${verdictLine}`,
      };
    }

    return { passed: verdictPass, report: verdictLine };
  }
}

// ── GitValidator（execFileSync adapter，#3） ─────────────────

export interface CommitValidation {
  commitHash: string;
  exists: boolean;
  inRepo: boolean;
  nonEmpty: boolean;
  /** 综合有效（三项全过）。 */
  valid: boolean;
  /** 失败时具体哪项挂（action 记 fail reason 用，#3 AC-3.4）。 */
  reason?: string;
}

/** git 可执行文件缺失判定（ENOENT = 基础设施异常，应 throw，T2.15）。 */
function isENOENT(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    String((e as { code: unknown }).code) === "ENOENT"
  );
}

/**
 * git 三项校验（§7 dev/test commit 真实性不变式）：
 *   1. cat-file -e：commit 存在
 *   2. merge-base --is-ancestor：属本仓库历史
 *   3. diff-tree --shortstat：非空 commit（拒 --allow-empty）
 *
 * 逐条独立（#3 方案 A 逐条容错）：action 拿结构化结果记 per-task fail，不 throw。
 * 例外（T2.15）：git 可执行文件缺失（ENOENT）= 基础设施异常，throw 让上层区分
 * infra vs business（commit 无效只是非零退出码，归 valid:false 业务 fail）。
 */
export class GitValidator {
  constructor(private workspacePath: string) {}

  validate(commitHash: string): CommitValidation {
    let exists = false;
    let inRepo = false;
    let nonEmpty = false;

    try {
      execFileSync("git", ["cat-file", "-e", `${commitHash}^{commit}`], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: "ignore",
      });
      exists = true;
    } catch (e) {
      if (isENOENT(e)) throw e;
      exists = false;
    }
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", commitHash, "HEAD"], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: "ignore",
      });
      inRepo = true;
    } catch (e) {
      if (isENOENT(e)) throw e;
      inRepo = false;
    }
    try {
      const stat = execFileSync("git", ["diff-tree", "--shortstat", "--root", commitHash], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      nonEmpty = stat.trim().length > 0;
    } catch (e) {
      if (isENOENT(e)) throw e;
      nonEmpty = false;
    }

    const valid = exists && inRepo && nonEmpty;
    let reason: string | undefined;
    if (!valid) {
      const parts: string[] = [];
      if (!exists) parts.push("cat-file");
      if (!inRepo) parts.push("merge-base");
      if (!nonEmpty) parts.push("empty");
      reason = parts.join(",");
    }
    return { commitHash, exists, inRepo, nonEmpty, valid, reason };
  }
}
