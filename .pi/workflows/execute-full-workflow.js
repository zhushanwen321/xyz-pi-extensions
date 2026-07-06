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
const { execSync } = require("child_process");

const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000; // 30 min，对齐 review-fix-loop
const DEFAULT_MAX_WORKTREES = 5; // ADR-029 开放问题 1：worktree 并发上限

// ── 入参（$ARGS）──────────────────────────────────────────────────
//
// 必需：topicId / topicDir / planPath / workspaceRoot
// 可选：baseRef(默认 main) / model / tier(默认 lite) / maxWorktrees(默认 5)

const TOPIC_ID = $ARGS.topicId;
const TOPIC_DIR = $ARGS.topicDir;
const PLAN_PATH = $ARGS.planPath;
const WORKSPACE_ROOT = $ARGS.workspaceRoot;
const BASE_REF = $ARGS.baseRef || "main";
const MODEL = $ARGS.model;
const TIER = $ARGS.tier || "lite";
const MAX_WORKTREES = $ARGS.maxWorktrees || DEFAULT_MAX_WORKTREES;

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

const worktrees = []; // {role, branch, path}
const runStamp = Date.now();

function git(args) {
  return execSync("git -C " + WORKSPACE_ROOT + " " + args, {
    encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function addWorktree(role) {
  const shortTopic = (TOPIC_ID || "cw").slice(0, 12);
  const branch = "cw-" + shortTopic + "-" + role + "-" + runStamp;
  const wtPath = WT_PARENT + "/cw-" + role + "-" + runStamp;
  try {
    git("worktree add " + wtPath + " -b " + branch + " " + BASE_REF);
    worktrees.push({ role, branch, path: wtPath });
    log("worktree 建好: " + role + " → " + wtPath);
    return wtPath;
  } catch (e) {
    throw new Error("git worktree add 失败 (" + role + "): " + e.message);
  }
}

function resetWorktree(wtPath) {
  // 复用前清前一 wave 残留：reset 到 BASE_REF + 删未跟踪文件
  try {
    execSync("git -C " + wtPath + " reset --hard " + BASE_REF, { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    execSync("git -C " + wtPath + " clean -fd", { encoding: "utf-8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    log("⚠ reset worktree 失败 " + wtPath + ": " + e.message);
  }
}

function removeWorktree(wt) {
  try {
    git("worktree remove --force " + wt.path);
    try { git("branch -D " + wt.branch); } catch { /* 忽略 */ }
    return null;
  } catch (e) {
    return { path: wt.path, branch: wt.branch, error: e.message };
  }
}

// ── Phase 0: worktree-setup ───────────────────────────────────────

phase("WorktreeSetup");

const maxParallelInWave = Math.max(1, ...devWaves2d.map((w) => w.length));
const devPoolSize = Math.min(maxParallelInWave, Math.max(1, MAX_WORKTREES - 2));
const devWtPool = [];
for (let i = 0; i < devPoolSize; i++) devWtPool.push(addWorktree("dev-pool" + i));
const testWt = testWaves2d.length > 0 ? addWorktree("test") : null;
const reviewWt = addWorktree("review");

log("worktree 建好：dev pool " + devWtPool.length + " (max parallel=" + maxParallelInWave + ") + test " + (testWt ? 1 : 0) + " + review 1 = " + worktrees.length);

// ── Prompt 构造器 ─────────────────────────────────────────────────

function buildImplementerPrompt(waveCase, worktreePath) {
  const changes = (waveCase.changes || []).join("\n  - ");
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
    "## 本 wave 改动点",
    "  - " + changes,
    "",
    "## TDD 步骤",
    "1. 先写失败测试（覆盖改动点的预期行为）",
    "2. 跑测试确认 fail（红）",
    "3. 写最小实现让测试 pass（绿）",
    "4. 重构（如需）",
    "5. 跑相关测试确认无回归",
    "6. git add + commit（message 描述本 wave 做了什么）",
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
const testFailures = [];
const reviewFailures = [];

// ── Phase 1: dev waves（wave 间串行，wave 内 parallel；硬依赖 abort）──

let devAborted = false;
for (let i = 0; i < devWaves2d.length; i++) {
  if (devAborted) break;
  const wave = devWaves2d[i];
  phase("Dev-w" + i + "(" + wave.map((c) => c.id).join(",") + ")");

  const waveWts = wave.map((_, j) => {
    const wt = devWtPool[j % devWtPool.length];
    resetWorktree(wt);
    return wt;
  });

  const calls = wave.map((c, j) => ({
    prompt: buildImplementerPrompt(c, waveWts[j]),
    schema: DEV_RESULT_SCHEMA,
    model: MODEL,
    cwd: waveWts[j],
    description: "dev-" + c.id,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  }));

  log("dev wave " + i + ": parallel " + calls.length + " implementer(s)...");
  const results = await parallel(calls);

  let waveOk = true;
  for (let j = 0; j < results.length; j++) {
    const r = parseResult(results[j]);
    const caseId = wave[j].id;
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

// ── Phase 2: test + review（test wave 串行，wave 内 parallel；review 首波并行）──

let testAborted = false;
let reviewCorrectness = null;
let reviewQuality = null;

for (let i = 0; i < testWaves2d.length; i++) {
  if (testAborted) break;
  const wave = testWaves2d[i];
  const isFirst = (i === 0);
  phase("Test-w" + i + "(" + wave.map((c) => c.id).join(",") + ")");

  const testCalls = wave.map((c) => ({
    prompt: buildTestRunnerPrompt(c, testWt),
    schema: TEST_RESULT_SCHEMA,
    model: MODEL,
    cwd: testWt,
    description: "test-" + c.id,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  }));
  const reviewCalls = isFirst ? [
    { prompt: buildReviewPrompt("correctness", reviewWt), schema: REVIEW_SCHEMA, model: MODEL, cwd: reviewWt, description: "review-correctness", timeoutMs: DEFAULT_AGENT_TIMEOUT_MS },
    { prompt: buildReviewPrompt("quality", reviewWt), schema: REVIEW_SCHEMA, model: MODEL, cwd: reviewWt, description: "review-quality", timeoutMs: DEFAULT_AGENT_TIMEOUT_MS },
  ] : [];

  const allCalls = [...testCalls, ...reviewCalls];
  log("test wave " + i + ": parallel " + testCalls.length + " test-runner" + (reviewCalls.length > 0 ? " + " + reviewCalls.length + " reviewer" : "") + "...");
  const results = await parallel(allCalls);

  const testResults = results.slice(0, testCalls.length);
  const reviewResults = reviewCalls.length > 0 ? results.slice(testCalls.length) : [];

  if (isFirst && reviewResults.length === 2) {
    reviewCorrectness = parseResult(reviewResults[0]);
    reviewQuality = parseResult(reviewResults[1]);
    if (!reviewCorrectness) reviewFailures.push("review-correctness");
    if (!reviewQuality) reviewFailures.push("review-quality");
  }

  let waveHasFail = false;
  for (let j = 0; j < testResults.length; j++) {
    const r = parseResult(testResults[j]);
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

// 无 testCases 时单独跑 review
if (testWaves2d.length === 0 && !reviewCorrectness && !reviewQuality) {
  phase("Review-only");
  log("无 testCases，单独并行跑 2 路 reviewer...");
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

let reviewMerged = null;
const reviewMergedPath = TOPIC_DIR + "/review-merged.md";
const totalMustFix = (reviewCorrectness?.must_fix ?? 0) + (reviewQuality?.must_fix ?? 0);
const totalShouldFix = (reviewCorrectness?.should_fix ?? 0) + (reviewQuality?.should_fix ?? 0);

if (reviewCorrectness || reviewQuality) {
  const readReport = (r) => {
    if (!r || !r.report_file) return "";
    try { return fs.readFileSync(r.report_file, "utf-8"); } catch { return ""; }
  };
  const cContent = readReport(reviewCorrectness);
  const qContent = readReport(reviewQuality);
  const extractMustFix = (content) => new Set(content.match(/\[(.+?):(\d+)\]/g) || []);
  const cSet = extractMustFix(cContent);
  const qSet = extractMustFix(qContent);
  const overlap = [...cSet].filter((x) => qSet.has(x));
  const union = new Set([...cSet, ...qSet]);
  const overlapRatio = union.size > 0 ? overlap.length / union.size : 0;
  const overlapLabel = overlapRatio > 0.8 ? "high" : overlapRatio > 0.3 ? "medium" : "low";

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

// ── Phase 3: cleanup（finally 语义，失败不阻塞）──────────────────

phase("Cleanup");
const cleanupFailures = [];
for (const wt of worktrees) {
  const err = removeWorktree(wt);
  if (err) cleanupFailures.push(err);
}
log("worktree 清理: " + (worktrees.length - cleanupFailures.length) + "/" + worktrees.length + " 成功");

// ── Return（主 agent 据此决策）─────────────────────────────────────

const allDevOk = !devAborted && devFailures.length === 0;
const allTestOk = !testAborted && testFailures.length === 0;
const reviewClean = totalMustFix === 0;

let nextHint;
if (!allDevOk) {
  nextHint = "dev 有失败/未完成，回 dev 修失败的 wave，或 ask_user 是否降级";
} else if (!allTestOk) {
  nextHint = "test 有 fail/未完成，读 failures 对 fail case ask_user（重跑 vs user-skipped+凭证）";
} else if (!reviewClean) {
  nextHint = "test 全绿但 review must_fix=" + totalMustFix + "，读 review-merged.md [HIGH-CONFIDENCE] 段必修后回 dev 修";
} else {
  nextHint = "全流程全绿。调 cw 读 topic 确认 dev/test gatePassed，然后 proceed to retrospect/closeout";
}

return {
  phase: "complete",
  cw_hint: "dev/test 的 cw 状态已由每个 agent 渐进式写入。主 agent 可调 cw 读 topic 确认 dev/test gatePassed 终态。",
  dev: { aborted: devAborted, waves_total: devWaves2d.length, failures: devFailures, all_ok: allDevOk },
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
  worktrees: {
    built: worktrees.length,
    cleaned: worktrees.length - cleanupFailures.length,
    cleanup_failures: cleanupFailures,
  },
  next_hint: nextHint,
  message: "execute-full-workflow 完成。dev " + (allDevOk ? "✓" : "✗") +
    " / test " + (allTestOk ? "✓" : "✗") +
    " / review " + (reviewClean ? "✓" : "must_fix=" + totalMustFix),
};
