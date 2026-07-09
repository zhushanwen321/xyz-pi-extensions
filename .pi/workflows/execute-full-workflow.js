const meta = {
  name: "execute-full-workflow",
  description:
    "CW coding-execute 全流程接管器（ADR-029）：worktree-setup → dev waves（渐进式 cw dev）→ test+review（渐进式 cw test）→ cleanup。per-call cwd 隔离每个 agent 到独占 worktree，parallel() 机器强制派发——堵住「小任务跳过 ensemble」的认知层逃逸。dev/test 的 cw 调用由每个 agent 完成后立即增量发起（决策 3 修订），workflow return 只含 review 汇总 + 失败清单 + cw 终态确认。",
  phases: [
    { title: "WorktreeSetup", detail: "读 plan.json → 建 dev worktree 池 + test/review worktree" },
    { title: "Dev", detail: "dev waves 二维数组：wave 间串行（dependsOn 拓扑序），wave 内 parallel（同 parallelGroup）。每 implementer 完成后渐进式调 cw(dev)" },
    { title: "Test+Review", detail: "test waves 二维数组 + 2 路 reviewer 并行只读审查。每 test-runner 完成后渐进式调 cw(test)" },
    { title: "Cleanup", detail: "git worktree remove（finally，失败不阻塞）" },
  ],
};

// ── 常量 & 全局依赖 ───────────────────────────────────────────────

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000; // 30 min，对齐 review-fix-loop
const DEFAULT_MAX_WORKTREES = 5; // ADR-029 开放问题 1：worktree 并发上限
const RESERVED_WORKTREES = 2; // 从 MAX_WORKTREES 预留：1 个 test worktree + 1 个 review worktree
const OVERLAP_HIGH_THRESHOLD = 0.8; // 两路 reviewer 问题重合度 ≥ 80% → HIGH-CONFIDENCE
const OVERLAP_MEDIUM_THRESHOLD = 0.3; // ≥ 30% → NEEDS-VERIFY；< 30% → LOW

// ── 入参（$ARGS）──────────────────────────────────────────────────
//
// 必需：topicId / topicDir / planPath / workspaceRoot
// 可选：baseRef(默认 main) / model / tier(默认 lite) / maxWorktrees(默认 5)

const TOPIC_ID = $ARGS.topicId;
const TOPIC_DIR = $ARGS.topicDir;
const PLAN_PATH = $ARGS.planPath;
// TOPIC_ROOT = 设计文档所在目录（issues.md/code-architecture.md 等在 topic 根目录，非 changes 子目录）。
// TOPIC_DIR 可能是 changes 子目录（coding-execute SKILL 约定），但设计文档在 topic 根目录。
// PLAN_PATH = .xyz-harness/{slug}/plan.json → dirname 即 topic 根目录。
const TOPIC_ROOT = path.dirname(PLAN_PATH);
const WORKSPACE_ROOT = $ARGS.workspaceRoot;
const BASE_REF = $ARGS.baseRef || "main";
const MODEL = $ARGS.model;
const TIER = $ARGS.tier || "lite";
const MAX_WORKTREES = $ARGS.maxWorktrees || DEFAULT_MAX_WORKTREES;

// ── Budget 配置（按 tier 动态选择）────────────────────────────────
// lite: 2M tokens, mid: 20M tokens
// 传入 workflow 时可通过 $ARGS.tokens 覆盖
const BUDGET_BY_TIER = {
  lite: 2_000_000,   // 200K × 10
  mid: 20_000_000,   // 2M × 10
  full: 50_000_000,  // 5M × 10（预留）
};
const DEFAULT_BUDGET_TOKENS = BUDGET_BY_TIER[TIER] || BUDGET_BY_TIER.lite;
const BUDGET_TOKENS = $ARGS.tokens || DEFAULT_BUDGET_TOKENS;
const BUDGET_TIME_MS = $ARGS.time || (TIER === "mid" ? 3_600_000 : 1_800_000); // mid: 60min, lite: 30min

const missing = [];
if (!TOPIC_ID) missing.push("topicId");
if (!TOPIC_DIR) missing.push("topicDir");
if (!PLAN_PATH) missing.push("planPath");
if (!WORKSPACE_ROOT) missing.push("workspaceRoot");
if (missing.length > 0) {
  throw new Error(
    "execute-full-workflow 缺少必需参数: " + missing.join(", ") +
    "。主 agent 须传 args={topicId, topicDir, planPath, workspaceRoot, baseRef?, model?, tier?, maxWorktrees?}"
  );
}
if (!fs.existsSync(TOPIC_DIR)) fs.mkdirSync(TOPIC_DIR, { recursive: true });
if (!fs.existsSync(PLAN_PATH)) throw new Error("planPath 不存在: " + PLAN_PATH);
if (!fs.existsSync(WORKSPACE_ROOT)) throw new Error("workspaceRoot 不存在: " + WORKSPACE_ROOT);

const WT_PARENT = WORKSPACE_ROOT + "/.cw-wt";
if (!fs.existsSync(WT_PARENT)) fs.mkdirSync(WT_PARENT, { recursive: true });

log("topicId=" + TOPIC_ID + " tier=" + TIER + " baseRef=" + BASE_REF);
log("topicDir=" + TOPIC_DIR);
log("workspaceRoot=" + WORKSPACE_ROOT);
log("budget: " + BUDGET_TOKENS.toLocaleString() + " tokens, " + (BUDGET_TIME_MS / 60_000).toFixed(0) + " min");

// ── 读 plan.json ──────────────────────────────────────────────────

let planWaves = [];
let planTestCases = [];
let planObjective = "";
try {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf-8"));
  planWaves = plan.waves || [];
  planTestCases = plan.testCases || [];
  planObjective = plan.objective || plan.businessGoal || "(无目标)";
} catch (e) {
  throw new Error("解析 plan.json 失败: " + e.message);
}
if (planWaves.length === 0) throw new Error("plan.json 无 waves，dev phase 无意义");
if (planTestCases.length === 0) log("⚠ plan.json 无 testCases，test phase 仅跑 review");

// ── wave 构造算法（ADR-029 决策 4）────────────────────────────────
// 输入扁平数组（含 dependsOn + parallelGroup）→ 输出二维数组（外串行/拓扑序，内 parallel/同组）

function topoSort(items) {
  const ids = new Set(items.map((i) => i.id));
  for (const i of items) {
    for (const d of (i.dependsOn || [])) {
      if (!ids.has(d)) throw new Error("依赖不存在: " + i.id + " → " + d);
    }
  }
  const sorted = [];
  const visited = new Set();
  const visiting = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("依赖环: " + id);
    visiting.add(id);
    const item = items.find((i) => i.id === id);
    for (const d of (item?.dependsOn || [])) visit(d);
    visiting.delete(id);
    visited.add(id);
    if (item) sorted.push(item);
  }
  for (const i of items) visit(i.id);
  return sorted;
}

function buildWaves(items) {
  // robustness #4：同 parallelGroup 内不得存在 dependsOn 关系（fail-fast）。
  // 同组 + 依赖 = 数据矛盾，buildWaves 会把它们打包进同一 wave parallel 执行，
  // 违反硬依赖。plan-parser 的 assertAcyclicDeps 只检环/未知 id，不检此矛盾。
  for (const item of items) {
    const deps = Array.isArray(item.dependsOn) ? item.dependsOn : [];
    for (const d of deps) {
      const dep = items.find((i) => i.id === d);
      if (dep && dep.parallelGroup && dep.parallelGroup === item.parallelGroup && item.parallelGroup) {
        throw new Error(
          "buildWaves: " + item.id + " dependsOn " + d + " 但同 parallelGroup \"" +
          item.parallelGroup + "\"——同组项不能有依赖（要么拆组，要么去掉 dependsOn）",
        );
      }
    }
  }
  const sorted = topoSort(items);
  const waves2d = [];
  let currentWave = [];
  let currentGroup = "__none__";
  for (const item of sorted) {
    const g = item.parallelGroup || "__none__";
    if (g === currentGroup && g !== "__none__") {
      currentWave.push(item);
    } else {
      if (currentWave.length > 0) waves2d.push(currentWave);
      currentWave = [item];
      currentGroup = g;
    }
  }
  if (currentWave.length > 0) waves2d.push(currentWave);
  return waves2d;
}

const devWaves2d = buildWaves(planWaves);
const testWaves2d = buildWaves(planTestCases);
log("dev waves: " + devWaves2d.length + " 个（" + devWaves2d.map((w) => w.map((c) => c.id).join("|")).join(" → ") + "）");
log("test waves: " + testWaves2d.length + " 个（" + testWaves2d.map((w) => w.map((c) => c.id).join("|")).join(" → ") + "）");

// ── Schemas ───────────────────────────────────────────────────────

const DEV_RESULT_SCHEMA = {
  type: "object",
  properties: {
    wave_id: { type: "string", description: "本次实现的 waveId" },
    commit_hash: { type: "string", description: "git commit hash（完整 40 字符）" },
    files_changed: { type: "array", items: { type: "string" } },
    tests_passed: { type: "boolean", description: "本 wave 的单测是否通过" },
    cw_submitted: { type: "boolean", description: "是否已调 cw(action=dev) 提交" },
  },
  required: ["wave_id", "commit_hash", "cw_submitted"],
};

const TEST_RESULT_SCHEMA = {
  type: "object",
  properties: {
    case_id: { type: "string", description: "本次测试的 caseId" },
    status: { type: "string", enum: ["pass", "fail"], description: "agent 自判 pass/fail，workflow 据此决定 wave abort" },
    evidence: { type: "string", description: "命令输出摘要 / 失败 file:line / 'no env: 原因'" },
    actual: { type: "object", description: "lite 路径：{url?, text?} 观测值（镜像传给 cw 的 actual）" },
    screenshot_path: { type: "string", description: "lite requiresScreenshot=true 时截图绝对路径（镜像传给 cw）" },
    commit_hash: { type: "string", description: "mid 路径：测试基于的 dev commit（镜像传给 cw）" },
    claimed_status: { type: "string", enum: ["passed", "failed"], description: "mid 路径：agent 声明（镜像传给 cw）" },
    cw_submitted: { type: "boolean", description: "是否已调 cw(action=test) 提交本 case 结果" },
  },
  required: ["case_id", "status", "cw_submitted"],
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "落盘的审查报告 .md 绝对路径" },
    must_fix: { type: "number" },
    should_fix: { type: "number" },
  },
  required: ["report_file", "must_fix"],
};

// ── worktree 管理（池化复用，ADR-029 开放问题 1+2）────────────────
//
// dev worktree 池：wave 间串行 → wave 开始时从池轮转取 worktree + reset 到 BASE_REF
// test/review worktree：全程独占（test 无 commit 副作用可共享；review 纯只读共享）

const GIT_CMD_TIMEOUT_MS = 30_000; // git 命令超时（worktree add/reset/remove）
const worktrees = []; // {role, branch, path}
const runStamp = Date.now();

// 所有 git 调用走 execFileSync（shell:false），避免路径/ref 含空格或特殊字符的注入风险。
function gitArgs(cwd, verb, args) {
  return execFileSync("git", ["-C", cwd, verb, ...args], {
    encoding: "utf-8", timeout: GIT_CMD_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function addWorktree(role) {
  return addWorktreeAt(role, BASE_REF);
}

// 从任意 ref 建 worktree（用于 Phase 1.5 从聚合分支建 test/review worktree）。
function addWorktreeAt(role, ref) {
  const shortTopic = (TOPIC_ID || "cw").slice(0, 12);
  const branch = "cw-" + shortTopic + "-" + role + "-" + runStamp;
  const wtPath = WT_PARENT + "/cw-" + role + "-" + runStamp;
  try {
    gitArgs(WORKSPACE_ROOT, "worktree", ["add", wtPath, "-b", branch, ref]);
    worktrees.push({ role, branch, path: wtPath });
    log("worktree 建好: " + role + " → " + wtPath + " (ref=" + ref + ")");
    return wtPath;
  } catch (e) {
    throw new Error("git worktree add 失败 (" + role + " @ " + ref + "): " + e.message);
  }
}

// 在 pool worktree 里建新分支并 checkout（给本轮 sub-wave 用）。
// ⚠️ 审查报告 CRITICAL #3 根因：原 resetWorktree(wt) 做 reset --hard BASE_REF，会把
// pool worktree 当前 checkout 的分支 ref 移到 BASE_REF，丢弃上一轮 sub-wave 在该分支
// 上的 commit。修复：不复用同一分支，而是每轮 sub-wave 建一个新分支（从 BASE_REF 起）
// 并 checkout 到 worktree。这样每轮的 commit 落在独立分支上，不会被下轮 reset 覆盖。
// Phase 1.5 聚合时收集所有这些 sub-wave 分支 merge。
// 返回新建分支名（供聚合使用）；worktrees 数组只记 role/path，分支名按 sub-wave 动态生成。
function newSubWaveBranch(wtPath, waveIdx, subBatchIdx, slotIdx) {
  const shortTopic = (TOPIC_ID || "cw").slice(0, 12);
  const branch = "cw-" + shortTopic + "-dev-w" + waveIdx + "s" + subBatchIdx + "p" + slotIdx + "-" + runStamp;
  try {
    // 从 BASE_REF 建新分支并 checkout 到该 worktree（worktree 会跳过自己的当前分支）
    gitArgs(wtPath, "checkout", ["-b", branch, BASE_REF]);
    // 清未跟踪文件（防上轮残留）
    gitArgs(wtPath, "clean", ["-fd"]);
    return branch;
  } catch (e) {
    throw new Error("建 sub-wave 分支失败 " + branch + " @ " + wtPath + ": " + e.message);
  }
}

function removeWorktree(wt) {
  try {
    gitArgs(WORKSPACE_ROOT, "worktree", ["remove", "--force", wt.path]);
    try { gitArgs(WORKSPACE_ROOT, "branch", ["-D", wt.branch]); } catch (e) { log("  branch 删除失败 (可接受): " + e.message); }
    return null;
  } catch (e) {
    return { path: wt.path, branch: wt.branch, error: e.message };
  }
}

// ── Phase 0: worktree-setup（仅建 dev pool；test/review 延后到 Phase 1.5 聚合后）───
//
// ADR-029 决策 2 + 审查报告 CRITICAL #1：test/review worktree 必须含全部 dev 改动才能
// 测真码/审真 diff。若 Phase 0 就建 test/review worktree（指向 BASE_REF），后续要靠
// `git checkout <aggregateBranch>` + `git reset --hard` 才能切到聚合点——但 worktree 已
// checkout 着自己的分支，切别的 ref 易踩「already checked out」/残留脏状态。
// 简洁方案：Phase 0 只建 dev pool；dev 全部完成后建聚合分支，再从聚合分支建 test/review
// worktree（`git worktree add <path> -b <branch> <aggregateBranch>`）。这样 testWt/
// reviewWt 天然含全部已 merge 的 dev 改动，无需 reset/checkout。

phase("WorktreeSetup");

const maxParallelInWave = Math.max(1, ...devWaves2d.map((w) => w.length));
const devPoolSize = Math.min(maxParallelInWave, Math.max(1, MAX_WORKTREES - RESERVED_WORKTREES));
const devWtPool = [];
for (let i = 0; i < devPoolSize; i++) devWtPool.push(addWorktree("dev-pool" + i));
// test/review worktree 延后到 Phase 1.5（dev 聚合后）建——指向 aggregateBranch
let testWt = null;
let reviewWt = null;

log("worktree 建好：dev pool " + devWtPool.length + " (max parallel=" + maxParallelInWave + ") + test/review 待 Phase 1.5 聚合后建 = " + worktrees.length);

// ── Prompt 构造器 ─────────────────────────────────────────────────

function buildImplementerPrompt(waveCase, worktreePath) {
  const isMid = TIER === "mid";
  // tier 感知：mid 用 issues 数组 + 设计文档路径；lite 用 changes 文件路径数组
  const taskSection = isMid
    ? [
        "## 本 wave 涉及的 issue",
        "  - " + (waveCase.issues || []).join("\n  - "),
        "",
        "## 设计文档（必读！改动细节在这里，不要凭猜测实现）",
        "  - " + TOPIC_ROOT + "/issues.md（issue 描述 + 验收标准 + 方案对比）",
        "  - " + TOPIC_ROOT + "/code-architecture.md（§3 API 契约签名表 + §4 时序图 + §6 测试矩阵）",
        "  - " + TOPIC_ROOT + "/code-skeleton/（骨架文件，按签名表填充实现）",
        "  - " + TOPIC_ROOT + "/execution-plan.md（Wave 依赖 + 测试验收清单）",
      ].join("\n")
    : "## 本 wave 改动点\n  - " + (waveCase.changes || []).join("\n  - ");
  return [
    "你是 implementer（TDD：先写失败测试 → 实现 → 跑通 → commit）。wave " + waveCase.id + "。",
    "",
    "## 目标",
    planObjective,
    "",
    "## 工作目录（你的独占 worktree）",
    worktreePath,
    "所有命令在此目录跑：`cd " + worktreePath + " && <cmd>`",
    "",
    taskSection,
    "",
    "## TDD 步骤",
    "1. 先写失败测试（覆盖改动点的预期行为）",
    "2. 跑测试确认 fail（红）",
    "3. 写最小实现让测试 pass（绿）",
    "4. 重构（如需）",
    "5. 跑相关测试确认无回归",
    "6. git status 检查改动文件列表，确认只改了本 wave 相关的文件（非本 wave 的文件不要动）",
    "7. git add <你改动的文件> + commit（message 描述本 wave 做了什么）",
    "",
    "⚠️ 工作区污染防护：禁止 git add -A / git add . 。你可能创建了临时文件（debug 日志、",
    "scratch 脚本等），commit 它们会污染聚合分支。只 git add 你为本 wave 改动的源码和测试文件。",
    "",
    "## 完成后强制（渐进式提交 cw）",
    "commit 后必须立即调 cw tool 提交本 wave 的 commitHash：",
    'cw(action="dev", topicId="' + TOPIC_ID + '", workspacePath="' + WORKSPACE_ROOT + '", ',
    '  tasks=[{waveId: "' + waveCase.id + '", commitHash: "<你的 commit hash 全 40 字符>"}])',
    "⚠️ workspacePath 必须传项目根（" + WORKSPACE_ROOT + "），不能用你的 cwd（你在 worktree 里，否则 cw 打开错误的 db）",
    "⚠️ 不调 cw = workflow 判你失败",
    "",
    "## 返回（structured-output）",
    "返回 {wave_id, commit_hash, files_changed, tests_passed, cw_submitted}。",
    "cw_submitted=true 仅在你确实调了 cw 且成功后。",
  ].join("\n");
}

function buildTestRunnerPrompt(testCase, worktreePath) {
  const layer = testCase.layer || "?";
  const needsShot = testCase.requiresScreenshot ? " [需截图]" : "";
  const isMid = TIER === "mid";
  const isRealLayer = layer === "real" || ["integration", "e2e", "perf-chaos"].includes(layer);
  const cwFields = isMid
    ? [
        "mid 路径（信声明 + GitValidator 校验 commitHash）：",
        '  caseId: "' + testCase.id + '",',
        '  commitHash: "<测试所基于的 dev commit hash 全 40 字符>",  // 必填',
        '  claimedStatus: "passed" | "failed",  // 必填，你的测试结论',
      ].join("\n")
    : [
        "lite 路径（机器重算，丢 claimedStatus）：",
        '  caseId: "' + testCase.id + '",',
        '  actual: {url?: "...", text?: "..."},  // 必填，你观测到的真实值',
        testCase.requiresScreenshot
          ? '  screenshotPath: "/abs/path.png",  // 必填（requiresScreenshot=true）'
          : '  // screenshotPath 可不填（requiresScreenshot=false）',
        "  // 注意：lite 不接受 status/claimedStatus，cw 用 actual 对比 expected 重算",
      ].join("\n");
  return [
    "你是 test-runner（只读，禁止改代码）。跑单条用例。case " + testCase.id + "。",
    "",
    "## 工作目录",
    worktreePath + "（含全部 dev 改动）",
    "命令显式带 cd：`cd " + worktreePath + " && <cmd>`",
    "",
    "## 用例信息",
    "- ID: " + testCase.id + "（" + layer + "层" + needsShot + "）",
    "- 场景: " + (testCase.scenario || "(无)"),
    "- 步骤: " + (testCase.steps || "(无)"),
    "- 执行方式: " + (testCase.executor || "(探测项目测试栈)"),
    testCase.expected ? "- 预期: " + JSON.stringify(testCase.expected) : "",
    testCase.assertion ? "- 断言: " + testCase.assertion : "",
    "",
    "## 执行",
    isRealLayer
      ? "real 层：需真实后端/数据。能真跑 → 跑并报结果。确无环境 → evidence='no env: <原因>'，cw 提交按下面规则（lite 无 actual 视为 fail；mid claimedStatus=failed）"
      : "mock 层：按 executor 指定命令跑，报结果 + evidence",
    "",
    "## 完成后强制（渐进式提交 cw）",
    "跑完后立即调 cw tool：",
    'cw(action="test", topicId="' + TOPIC_ID + '", workspacePath="' + WORKSPACE_ROOT + '", cases=[{ ... }])',
    "⚠️ workspacePath 必须传项目根（" + WORKSPACE_ROOT + "）",
    "",
    "### cw cases[] 字段（按 tier 分支）：",
    cwFields,
    "",
    "## 返回（structured-output，给 workflow 看，与 cw 字段独立）",
    "返回 {case_id, status, evidence, actual?, screenshot_path?, commit_hash?, claimed_status?, cw_submitted}。",
    "- status: 'pass' | 'fail'（你自判，workflow 据此决定 wave abort）",
    "- evidence: 命令输出摘要 / 失败 file:line / 'no env: 原因'",
    "- actual/screenshot_path/commit_hash/claimed_status: 镜像你传给 cw 的字段",
    "- cw_submitted: true 仅在你确实调了 cw 且成功后",
  ].join("\n");
}

function buildReviewPrompt(dimension, worktreePath) {
  const isC = dimension === "correctness";
  return [
    "你是 code-reviewer（只读审查）。审查 git diff " + BASE_REF + "...HEAD，聚焦【" +
    (isC ? "业务逻辑正确性 + 类型安全 + 边界条件" : "测试覆盖 + 代码规范 + 边界条件") + "】。",
    "",
    "## 工作目录（review worktree）",
    worktreePath,
    "看 diff: `cd " + worktreePath + " && git diff " + BASE_REF + "...HEAD`",
    "",
    "## 审查维度",
    isC
      ? "- 业务逻辑正确性：实现符合 plan 目标？分支/循环逻辑对吗？\n- 类型安全：有无 any、断言安全、类型守卫完整\n- 边界条件：空值/并发/最大值/异常输入"
      : "- 测试覆盖：新逻辑有无测试？边界用例？vitest 框架规范？\n- 代码规范：命名、行数（文件<1000/函数<80）、import 顺序、错误处理\n- 边界条件：空值/并发（冗余维度，与正确性组重叠）",
    "",
    "## 输出（落盘）",
    "报告写入: " + TOPIC_DIR + "/review-" + dimension + ".md",
    "格式：\n## Must Fix（必修）\n- [文件:行] 问题 + 修复方向\n## Should Fix（建议）\n- ...\n## Nit（细节）\n- ...",
    "",
    "## 返回（structured-output）",
    "返回 {report_file, must_fix, should_fix}。",
  ].join("\n");
}

function parseResult(raw) {
  return (typeof raw === "object" && raw !== null) ? raw : null;
}

const devFailures = [];
const devMergeFailures = []; // Phase 1.5 dev 分支 merge 到聚合分支失败的记录（CRITICAL #1+#3）
const devSubWaveBranches = []; // 所有 sub-wave 分支名（每轮 newSubWaveBranch 生成），供 Phase 1.5 聚合
const testFailures = [];
const reviewFailures = [];
const cleanupFailures = []; // finally 块填充
let devAborted = false; // try 外声明，catch 块可访问
let testAborted = false; // try 外声明，catch 块可访问
let reviewCorrectness = null;
let reviewQuality = null;
let reviewMerged = null;
let totalMustFix = 0;
let totalShouldFix = 0;
let devMergeClean = true; // 会在 try 块内更新

// SHOULD_FIX（审查 robustness + CRITICAL #4）：Phase 1/2/聚合 任一 throw 也必须跑 cleanup
// （防 worktree 泄漏）。try/catch/finally 包裹整个执行体：
//   - 正常路径：body 设 result，finally 跑 cleanup 填充 cleanupFailures，return result 在外面
//   - 异常路径：catch 记 result.phase="failed"，finally 跑 cleanup，return result（不重抛——
//     让主 agent 收到带 cleanup_failures 的失败结果，而非 workflow 引擎的 throw 堆栈）
// ⚠️ CRITICAL #4 原因：旧版 return 在 try 块内，JS 语义下 return 表达式先求值（此时
// cleanupFailures 还未被 finally 填充），主 agent 永远收到 cleanup_failures=[]。
let result;
try {
// ── Phase 1: dev waves（wave 间串行，wave 内 parallel；硬依赖 abort）──
for (let i = 0; i < devWaves2d.length; i++) {
  if (devAborted) break;
  const wave = devWaves2d[i];
  phase("Dev-w" + i + "(" + wave.map((c) => c.id).join(",") + ")");

  // MUST_FIX（审查 robustness）：wave 超过 pool 时不别名复用——拆子波串行，每子波≤ pool。
  // 别名复用会让 2 个 agent 写同一个 worktree（git index lock 冲突、commit 丢失）。
  // ⚠️ 审查报告 CRITICAL #3：不复用同一分支——每轮 sub-wave 在 pool worktree 里建新分支
  // （newSubWaveBranch），这样每轮的 commit 落在独立分支上，不会被下轮 reset 覆盖。
  const subBatchSize = Math.min(wave.length, devWtPool.length);
  const subBatchCount = Math.ceil(wave.length / subBatchSize);
  const waveResults = [];
  const waveCaseIds = [];
  for (let sb = 0; sb < subBatchCount; sb++) {
    const start = sb * subBatchSize;
    const subWave = wave.slice(start, start + subBatchSize);
    const subWts = [];
    const subBranches = [];
    for (let j = 0; j < subWave.length; j++) {
      const wt = devWtPool[j]; // subWave.length ≤ devWtPool.length，1:1 分配
      const branch = newSubWaveBranch(wt, i, sb, j); // 每轮 sub-wave 新分支
      subWts.push(wt);
      subBranches.push(branch);
    }
    const subCalls = subWave.map((c, j) => ({
      prompt: buildImplementerPrompt(c, subWts[j]),
      schema: DEV_RESULT_SCHEMA,
      model: MODEL,
      cwd: subWts[j],
      description: "dev-" + c.id,
      timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
    }));
    log("dev wave " + i + " 子波 " + sb + ": parallel " + subCalls.length + " implementer(s)");
    const subResults = await parallel(subCalls);
    waveResults.push(...subResults);
    waveCaseIds.push(...subWave.map((c) => c.id));
    // 收集本轮 sub-wave 分支名，供 Phase 1.5 聚合 merge（即使 agent 失败也收——
    // 失败的 case 可能没 commit，分支 HEAD==BASE_REF，merge 为 no-op）
    for (const b of subBranches) devSubWaveBranches.push(b);
  }

  let waveOk = true;
  for (let j = 0; j < waveResults.length; j++) {
    const r = parseResult(waveResults[j]);
    const caseId = waveCaseIds[j];
    if (!r || !r.commit_hash || !r.cw_submitted) {
      const reason = !r ? "agent 无返回" : (!r.commit_hash ? "无 commit_hash" : "未调 cw_submitted");
      devFailures.push({ waveId: caseId, reason });
      log("  ✗ dev " + caseId + " 失败: " + reason);
      waveOk = false;
    } else {
      log("  ✓ dev " + caseId + " commit=" + r.commit_hash.slice(0, 8) + " cw=已提交");
    }
  }
  if (!waveOk) {
    log("dev wave " + i + " 有失败，abort 后续 dev wave（硬依赖）");
    devAborted = true;
  }
}

// ── Phase 1.5: dev 提交汇聚（聚合分支）────────────────────────────
// 审查报告 CRITICAL #1 + #3：
//   - #3：dev pool worktree 下一轮 sub-wave 被 reset，丢上一轮 commit。
//   - #1：test/review worktree 无 merge，停在旧码。
// 修复（已在 dev wave 逐轮 newSubWaveBranch 生成分支，本阶段 merge 它们）：
//   1. 从 BASE_REF 建聚合分支 + 一个临时聚合 worktree（checkout 到聚合分支）。
//   2. 按顺序 merge 每个 sub-wave 分支（devSubWaveBranches）。merge 冲突不 throw，
//      abort 后记入 devMergeFailures，让主 agent 决策。
//   3. test/review worktree 从聚合分支建（延后建方案），天然含 dev 改动。
// merge 失败时：review 仍跑（审已 merge 的部分），test 跳过（测部分代码不如不测）。

phase("DevAggregate");

const aggregateBranch = "cw-" + TOPIC_ID.slice(0, 12) + "-dev-aggregate-" + runStamp;
const aggregateWtPath = WT_PARENT + "/cw-aggregate-" + runStamp;
try {
  // 建聚合分支 + 聚合 worktree（checkout 到 aggregateBranch）
  gitArgs(WORKSPACE_ROOT, "worktree", ["add", aggregateWtPath, "-b", aggregateBranch, BASE_REF]);
  worktrees.push({ role: "aggregate", branch: aggregateBranch, path: aggregateWtPath });
  log("聚合 worktree 建好：" + aggregateWtPath + " (branch=" + aggregateBranch + "，从 " + BASE_REF + " 起)");
} catch (e) {
  throw new Error("建聚合分支/worktree 失败 " + aggregateBranch + ": " + e.message);
}

// 按 sub-wave 顺序 merge 每个分支（保持拓扑序，后建立的分支依赖先 merge 的）
for (const subBranch of devSubWaveBranches) {
  // skip 重复名（理论不会，防御）
  try {
    gitArgs(aggregateWtPath, "merge", ["--no-ff", "--no-edit", subBranch, "-m", "merge " + subBranch]);
    log("  ✓ merge " + subBranch);
  } catch (e) {
    // merge 冲突：abort 避免脏状态，记录失败，继续下一个
    try { gitArgs(aggregateWtPath, "merge", ["--abort"]); } catch (_) { /* ignore */ }
    devMergeFailures.push({ branch: subBranch, error: e.message });
    log("  ✗ merge " + subBranch + " 失败（记入 dev.merge_failures）: " + e.message);
  }
}

const mergeClean = devMergeFailures.length === 0;
log("dev 聚合 " + (mergeClean ? "成功" : "有冲突（" + devMergeFailures.length + " 个分支未 merge）"));

// test/review worktree 延后建（现在聚合分支就绪）。
// merge 失败时仍建 review worktree（审已 merge 的部分）但跳过 test worktree（测部分
// 代码不如不测）。
if (testWaves2d.length > 0 && mergeClean) {
  testWt = addWorktreeAt("test", aggregateBranch);
} else if (testWaves2d.length > 0 && !mergeClean) {
  log("dev 聚合有冲突，跳过建 test worktree（主 agent 决策后重跑）");
}
reviewWt = addWorktreeAt("review", aggregateBranch);
log("test/review worktree 建好：test " + (testWt ? 1 : 0) + " + review 1（指向 " + aggregateBranch + "）");

// ── Phase 2: test waves（wave 间串行，wave 内 parallel）+ review（独立并行）──
// 审查 robustness SHOULD_FIX：reviewer 从 test wave 0 解耦——test waves 只跑 test-runner，
// 所有 test waves 完成后独立并行跑 2 路 reviewer。避免 reviewer 延迟耦合 test wave abort 逻辑。

// testAborted, reviewCorrectness, reviewQuality, reviewMerged, totalMustFix, totalShouldFix 在 try 外声明

// merge 失败时 testWt 为 null（跳过测试）——记录 infra 失败让主 agent 决策
if (testWaves2d.length > 0 && !testWt) {
  testFailures.push({
    caseId: "(all)",
    reason: "dev 聚合有冲突（dev.merge_failures 非空），test worktree 未建，跳过测试阶段",
  });
  testAborted = true;
  log("test 阶段跳过（dev 聚合冲突）");
}

for (let i = 0; i < testWaves2d.length; i++) {
  if (testAborted) break;
  const wave = testWaves2d[i];
  phase("Test-w" + i + "(" + wave.map((c) => c.id).join(",") + ")");

  const testCalls = wave.map((c) => ({
    prompt: buildTestRunnerPrompt(c, testWt),
    schema: TEST_RESULT_SCHEMA,
    model: MODEL,
    cwd: testWt,
    description: "test-" + c.id,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  }));

  log("test wave " + i + ": parallel " + testCalls.length + " test-runner(s)");
  const results = await parallel(testCalls);

  let waveHasFail = false;
  for (let j = 0; j < results.length; j++) {
    const r = parseResult(results[j]);
    const caseId = wave[j].id;
    if (!r || !r.cw_submitted) {
      testFailures.push({ caseId, reason: !r ? "agent 无返回" : "未调 cw_submitted" });
      log("  ✗ test " + caseId + " 失败（未提交 cw）");
      waveHasFail = true;
    } else if (r.status === "fail") {
      log("  ✗ test " + caseId + " = fail（" + (r.evidence || "?").slice(0, 60) + "）");
      waveHasFail = true;
    } else {
      log("  ✓ test " + caseId + " = pass");
    }
  }
  if (waveHasFail) {
    log("test wave " + i + " 有 fail，abort 后续 test wave（硬依赖）");
    testAborted = true;
  }
}

// review 独立并行跑（所有 test waves 完成后，或无 testCases 时）
// dataflow D3 防护：merge 冲突时 reviewWt 只含部分 dev 改动，review 会审部分代码——
// 与 test 同策略（「审部分代码不如不审」），跳过 review，让主 agent 先修 merge 冲突重跑。
// 注意：用 mergeClean（第 550 行已算好），不用 devMergeClean（此时仍为初始 true，700 行才更新）。
if (!mergeClean) {
  phase("Review-skipped");
  log("⚠ dev 聚合有 merge 冲突（" + devMergeFailures.length + " 分支未 merge），跳过 review（审部分代码不如不审）。主 agent 修 merge 后重跑 workflow。");
  // reviewCorrectness/reviewQuality 保持 null，reviewFailures 不 push（跳过非失败）
} else {
  phase("Review");
  log("并行跑 2 路 reviewer（correctness + quality）...");
  const [rcRaw, rqRaw] = await parallel([
    { prompt: buildReviewPrompt("correctness", reviewWt), schema: REVIEW_SCHEMA, model: MODEL, cwd: reviewWt, description: "review-correctness", timeoutMs: DEFAULT_AGENT_TIMEOUT_MS },
    { prompt: buildReviewPrompt("quality", reviewWt), schema: REVIEW_SCHEMA, model: MODEL, cwd: reviewWt, description: "review-quality", timeoutMs: DEFAULT_AGENT_TIMEOUT_MS },
  ]);
  reviewCorrectness = parseResult(rcRaw);
  reviewQuality = parseResult(rqRaw);
  if (!reviewCorrectness) reviewFailures.push("review-correctness");
  if (!reviewQuality) reviewFailures.push("review-quality");
}

// ── Review 聚合（2 路去重合并）────────────────────────────────────

phase("Aggregate-review");

const reviewMergedPath = TOPIC_DIR + "/review-merged.md";
totalMustFix = (reviewCorrectness?.must_fix ?? 0) + (reviewQuality?.must_fix ?? 0);
totalShouldFix = (reviewCorrectness?.should_fix ?? 0) + (reviewQuality?.should_fix ?? 0);

if (reviewCorrectness || reviewQuality) {
  const readReport = (r) => {
    if (!r || !r.report_file) return "";
    try { return fs.readFileSync(r.report_file, "utf-8"); } catch (e) { log("⚠ 读 review 报告失败 " + r.report_file + ": " + e.message); return ""; }
  };
  const cContent = readReport(reviewCorrectness);
  const qContent = readReport(reviewQuality);
  const extractMustFix = (content) => new Set(content.match(/\[(.+?):(\d+)\]/g) || []);
  const cSet = extractMustFix(cContent);
  const qSet = extractMustFix(qContent);
  const overlap = [...cSet].filter((x) => qSet.has(x));
  const union = new Set([...cSet, ...qSet]);
  const overlapRatio = union.size > 0 ? overlap.length / union.size : 0;
  const overlapLabel = overlapRatio > OVERLAP_HIGH_THRESHOLD ? "high" : overlapRatio > OVERLAP_MEDIUM_THRESHOLD ? "medium" : "low";

  const merged = [
    "---",
    'review_ensemble_overlap: "' + overlapLabel + '"',
    "review_correctness_must_fix: " + (reviewCorrectness?.must_fix ?? 0),
    "review_quality_must_fix: " + (reviewQuality?.must_fix ?? 0),
    "---",
    "",
    "# Review Ensemble 合并报告",
    "",
    "## 趋同分析（重合度 " + overlapLabel + " = " + Math.round(overlapRatio * 100) + "%）",
    "- 两路重合 must_fix 位置: " + overlap.length,
    "- 并集 must_fix 位置: " + union.size,
    "",
    "## [HIGH-CONFIDENCE] 两路都报（必修）",
    overlap.length > 0 ? overlap.map((x) => "- " + x).join("\n") : "(无)",
    "",
    "## [NEEDS-VERIFY] 仅一路报（主 agent 复核）",
    "### 仅正确性组", [...cSet].filter((x) => !qSet.has(x)).map((x) => "- " + x).join("\n") || "(无)",
    "### 仅质量组", [...qSet].filter((x) => !cSet.has(x)).map((x) => "- " + x).join("\n") || "(无)",
    "",
    "## 原始报告",
    "### 正确性组", cContent || "(读取失败)",
    "### 质量组", qContent || "(读取失败)",
  ].join("\n");
  try {
    fs.writeFileSync(reviewMergedPath, merged);
    reviewMerged = { file: reviewMergedPath, overlap: overlapLabel, total_must_fix: totalMustFix };
    log("review-merged.md 落盘 (overlap=" + overlapLabel + ", must_fix=" + totalMustFix + ")");
  } catch (e) {
    log("⚠ review-merged.md 写入失败: " + e.message);
  }
}

// ── Return（主 agent 据此决策）cleanup 由 finally 块负责（CRITICAL #4），return 在 try 外。
//

const allDevOk = !devAborted && devFailures.length === 0;
const allTestOk = !testAborted && testFailures.length === 0;
const reviewClean = totalMustFix === 0;
devMergeClean = devMergeFailures.length === 0; // 更新 try 外声明的变量

let nextHint;
if (!allDevOk) {
  nextHint = "dev 有失败/未完成，回 dev 修失败的 wave，或 ask_user 决策";
} else if (!devMergeClean) {
  nextHint = "dev 聚合有 merge 冲突（dev.merge_failures 非空，共 " + devMergeFailures.length + " 个分支）。读 dev.merge_failures 看冲突分支，回阶段 A 修冲突后重跑 workflow，或 ask_user 决策";
} else if (!allTestOk) {
  nextHint = "test 有 fail/未完成，读 failures 对 fail case ask_user（重跑 vs user-skipped+凭证）";
} else if (!reviewClean) {
  nextHint = "test 全绿但 review must_fix=" + totalMustFix + "，读 review-merged.md [HIGH-CONFIDENCE] 段必修后回 dev 修";
} else {
  nextHint = "全流程全绿。调 cw 读 topic 确认 dev/test gatePassed，然后 proceed to retrospect/closeout";
}

result = {
  phase: "complete",
  cw_hint: "dev/test 的 cw 状态已由每个 agent 渐进式写入。主 agent 可调 cw 读 topic 确认 dev/test gatePassed 终态。",
  budget: {
    tier: TIER,
    configured_tokens: BUDGET_TOKENS,
    configured_time_ms: BUDGET_TIME_MS,
    note: "实际 token 消耗由 workflow 引擎追踪，可通过 workflow status 查看"
  },
  dev: {
    aborted: devAborted,
    waves_total: devWaves2d.length,
    failures: devFailures,
    merge_failures: devMergeFailures,
    merge_clean: devMergeClean,
    all_ok: allDevOk,
  },
  test: { aborted: testAborted, waves_total: testWaves2d.length, failures: testFailures, all_ok: allTestOk },
  review: {
    merged_file: reviewMerged?.file ?? null,
    overlap: reviewMerged?.overlap ?? null,
    total_must_fix: totalMustFix,
    total_should_fix: totalShouldFix,
    correctness: reviewCorrectness,
    quality: reviewQuality,
    failures: reviewFailures,
    clean: reviewClean,
  },
  next_hint: nextHint,
  message: "execute-full-workflow 完成。dev " + (allDevOk ? "✓" : "✗") +
    (devMergeClean ? "" : " merge 冲突=" + devMergeFailures.length) +
    " / test " + (allTestOk ? "✓" : "✗") +
    " / review " + (reviewClean ? "✓" : "must_fix=" + totalMustFix),
};
} catch (err) {
  // 异常路径：记录失败，finally 仍跑 cleanup。result 在 finally 后 return。
  // 注意：aggregateBranch/mergeClean/devMergeClean 在 try 内才声明，此处不可访问——
  // 用 devMergeFailures（try 外声明的失败数组）重算，安全。
  log("⚠ workflow 执行抛异常: " + (err?.message ?? err));
  result = {
    phase: "failed",
    error: err?.message ?? String(err),
    budget: {
      tier: TIER,
      configured_tokens: BUDGET_TOKENS,
      configured_time_ms: BUDGET_TIME_MS,
      note: "实际 token 消耗由 workflow 引擎追踪，可通过 workflow status 查看"
    },
    dev: { aborted: devAborted, waves_total: devWaves2d.length, failures: devFailures, merge_failures: devMergeFailures, merge_clean: devMergeFailures.length === 0, all_ok: !devAborted && devFailures.length === 0 },
    test: { aborted: testAborted, waves_total: testWaves2d.length, failures: testFailures, all_ok: false },
    review: {
      merged_file: reviewMerged?.file ?? null,
      total_must_fix: totalMustFix,
      failures: reviewFailures,
      clean: false,
    },
    next_hint: "workflow 执行抛异常（见 error）。读 dev.merge_failures / dev.failures 定位，回阶段 A 修后重跑，或 ask_user 决策",
    message: "execute-full-workflow 失败: " + (err?.message ?? err),
  };
} finally {
  // ADR-029 决策 / 审查 robustness SHOULD_FIX：worktree 必须清理（防泄漏），无论上述是否 throw。
  // CRITICAL #4 修复：finally 在 result 赋值后、return result 前跑，填充 cleanupFailures。
  phase("Cleanup-finally");
  for (const wt of worktrees) {
    const err = removeWorktree(wt);
    if (err) cleanupFailures.push(err);
  }
  log("worktree 清理: " + (worktrees.length - cleanupFailures.length) + "/" + worktrees.length + " 成功");
}

// return 在 try/catch/finally 外，cleanupFailures 已被 finally 填充（CRITICAL #4 根因修复）
result.worktrees = {
  built: worktrees.length,
  cleaned: worktrees.length - cleanupFailures.length,
  cleanup_failures: cleanupFailures,
};
return result;
