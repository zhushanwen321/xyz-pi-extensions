/**
 * gates — gate 注册表 + 执行器 + check/git adapter（§5 architecture）。
 *
 * 内容：
 *   - GATE_REGISTRY 声明式数组（§5.2 的 11 行表 1:1 编码，#4 方案 A）
 *   - runGate 通用执行器（串行 fail-fast，§5.3）
 *   - lookupGateTier（progressive gate 透传 gateTier 到 gateHistory）
 *   - GateRunner（dispatch 到 checks/ 下的 TS check 函数，原 python subprocess 已移除）
 *   - GitValidator（execFileSync adapter，#3，真引 git 三项校验）
 *
 * Adapter 真引 SDK（Tier 2 证伪）：execFileSync 真调用 + 透传参数，
 * 让 tsc 对 node:child_process 声明验签。
 *
 * 与骨架的分歧（nfr #3 + T2.15）：
 *   - GitValidator：git ENOENT（可执行文件缺失）→ throw infra-error；commit 无效（非零退出）
 *     → {valid:false} 业务 fail。catch 里按 errno.code === 'ENOENT' 区分。
 *   - GateRunner：dispatch 到 TS check 函数，crash 兜底返 infraError（业务 fail 由 check 自返 passed:false）。
 */

import { execFileSync } from "node:child_process";

import { runCheckArchitecture } from "./checks/check-architecture.js";
import { runCheckClarity } from "./checks/check-clarity.js";
import { runCheckCloseout } from "./checks/check-closeout.js";
import { runCheckCodeArch } from "./checks/check-code-arch.js";
import { runCheckExecution } from "./checks/check-execution.js";
import { runCheckIssues } from "./checks/check-issues.js";
import { runCheckNfr } from "./checks/check-nfr.js";
import { runCheckPlan } from "./checks/check-plan.js";
import type { CheckOutput } from "./checks/shared.js";
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

// ── GateRunner（check 函数 dispatch，原 subprocess adapter 已移除） ──

/**
 * CheckOutput —— 单一来源在 checks/shared.ts，此处 re-export 保持外部 import 兼容。
 *
 * gate 消费链：check 函数 → CheckOutput → buildChecker → CheckerResult → GateResult。
 * 只要这个接口不动，buildChecker/runGate/4 个 action handler 零改动。
 */
export type { CheckOutput };

/**
 * check 函数 dispatch 表。
 *
 * key = GATE_REGISTRY 里 buildChecker 的 scriptPath 字符串（保持原值，当 dispatch key）。
 * value = 移植后的 TS check 函数（签名 (topicDir) => CheckOutput）。
 *
 * 未实现的 check 暂用占位（throw infraError），逐步填充。
 */
type CheckFn = (topicDir: string) => CheckOutput;

const CHECK_DISPATCH: Record<string, CheckFn> = {
  "check_clarity.py": runCheckClarity,
  "check_architecture.py": runCheckArchitecture,
  "check_issues.py": runCheckIssues,
  "check_nfr.py": runCheckNfr,
  "check_code_arch.py": runCheckCodeArch,
  "check_execution.py": runCheckExecution,
  "check_plan.py": runCheckPlan,
  "check_closeout.py": runCheckCloseout,
};

/**
 * dispatch 到 TS check 函数（取代原 spawnSync python）。
 *
 * 历史 bug：原 spawnSync 版本因 topicDir 绝对路径触发 hasPathTraversal 拒绝、
 * scriptPath 相对路径找不到 python 脚本，gate 从未真正跑通。TS 函数方案彻底消除
 * subprocess 边界、stdout 文本契约、path traversal 防御。
 *
 * infraError 场景（TS 函数世界）：
 *   - 未知 scriptPath key → infraError（dispatch 表未注册）
 *   - check 函数 throw → infraError（crash 兜底，业务 fail 由 check 自己返回 passed:false）
 */
export class GateRunner {
  constructor(private cwd: string) {}

  runCheck(scriptPath: string, topicDir: string): CheckOutput {
    const fn = CHECK_DISPATCH[scriptPath];
    if (!fn) {
      return {
        passed: false,
        infraError: `unknown check: ${scriptPath}（dispatch 表未注册）`,
      };
    }
    try {
      return fn(topicDir);
    } catch (e) {
      return {
        passed: false,
        infraError: `check crashed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
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
