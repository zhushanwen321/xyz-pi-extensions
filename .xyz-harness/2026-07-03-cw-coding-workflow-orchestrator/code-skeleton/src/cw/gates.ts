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
 */

import { execFileSync, spawnSync } from "node:child_process";

import type { CwAction, CwTopic, GateTier, Tier } from "./types.js";

// ── gate 强度定义（§5.1） ────────────────────────────────────

// GateTier 见 types.ts：weak-structural / medium-git / medium-coverage / strong-recompute

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
 * §5.2 的 11 行表 1:1 编码。checkers 是 in-process 闭包，调 ctx.runner/git。
 * progressive 行（dev/test）checkers 空——action handler 直接调 GitValidator/judgeByExpected。
 *
 * 叶子：checkers 闭包体留 ⑥Wave（调 ctx.runner.runCheck(scriptPath, topicDir)）。
 */
function buildChecker(scriptPath: string): Checker {
  return (ctx: GateContext): CheckerResult => {
    // 接线：调 runner 真跑 check 脚本。
    const out = ctx.runner.runCheck(scriptPath, ctx.topicDir);
    return { name: scriptPath, passed: out.passed, report: out.report };
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
  // 接线：查表 → 串行跑 checkers → fail-fast → 聚合。
  const rule = findRule(tier, phase);
  const reports: CheckerResult[] = [];
  for (const checker of rule.checkers) {
    // 接线：调 checker 闭包（其内部调 ctx.runner）。
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
  // 接线：查 registry 返回 gateTier。
  return findRule(tier, phase).gateTier;
}

// ── GateRunner（subprocess adapter，#6） ─────────────────────

export interface CheckOutput {
  passed: boolean;
  report?: string;
  /** crash / timeout → infraError（业务 fail vs 基础设施异常，#6 方案 A）。 */
  infraError?: string;
}

/**
 * spawnSync 调 python check_*.py，解析 stdout 末行 verdict。
 *
 * 输出契约（_shared_check_lib.finalize_and_exit）：
 *   stdout 末行：`[{phase}] machine check: {passed}/{total} passed → PASS|FAIL`
 *   exit 0 = pass，exit 1 = 业务 fail，exit 2 = usage error（infra）。
 *
 * 真引 spawnSync（Tier 2 证伪）：tsc 对 node:child_process 声明验签。
 */
export class GateRunner {
  constructor(private cwd: string) {}

  runCheck(scriptPath: string, topicDir: string): CheckOutput {
    // SDK 契约：spawnSync(command, args, options) → { status, stdout, stderr, signal }。
    const result = spawnSync(
      "python3",
      [scriptPath, topicDir],
      { cwd: this.cwd, encoding: "utf8", timeout: 60_000 },
    );
    // 超时 / crash（status=null 或 signal=SIGTERM）→ infraError。
    if (result.status === null || result.signal) {
      return {
        passed: false,
        infraError: `subprocess ${result.signal ?? "crash"}: ${result.stderr.slice(0, 200)}`,
      };
    }
    // exit 2 = usage error（infra）。
    if (result.status === 2) {
      return { passed: false, infraError: `usage error: ${result.stderr.slice(0, 200)}` };
    }
    // 业务 verdict：解析 stdout 末行（#6 方案 A 双信号：verdict 行 + exit code）。
    const verdictLine = result.stdout
      .split("\n")
      .filter((l) => l.includes("machine check"))
      .pop();
    const passed = result.status === 0 && verdictLine?.includes("PASS") === true;
    return {
      passed,
      report: verdictLine ?? result.stdout.slice(-200),
    };
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

/**
 * git 三项校验（§7 dev/test commit 真实性不变式）：
 *   1. cat-file -e：commit 存在
 *   2. merge-base --is-ancestor：属本仓库历史
 *   3. diff-tree --shortstat：非空 commit（拒 --allow-empty）
 *
 * 逐条独立（#3 方案 A 逐条容错）：action 拿结构化结果记 per-task fail，不 throw。
 * 真引 execFileSync（Tier 2 证伪）。
 */
export class GitValidator {
  constructor(private workspacePath: string) {}

  validate(commitHash: string): CommitValidation {
    // 接线：三项 execFileSync，任一抛 → 该项 false。
    let exists = false;
    let inRepo = false;
    let nonEmpty = false;
    try {
      // SDK 契约：execFileSync 抛非零退出码 Error。
      execFileSync("git", ["cat-file", "-e", `${commitHash}^{commit}`], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: "ignore",
      });
      exists = true;
    } catch {
      exists = false;
    }
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", commitHash, "HEAD"], {
        cwd: this.workspacePath,
        encoding: "utf8",
        stdio: "ignore",
      });
      inRepo = true;
    } catch {
      inRepo = false;
    }
    try {
      const stat = execFileSync(
        "git",
        ["diff-tree", "--shortstat", "--root", commitHash],
        { cwd: this.workspacePath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      nonEmpty = stat.trim().length > 0;
    } catch {
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
