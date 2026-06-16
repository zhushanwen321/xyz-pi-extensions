const meta = {
  name: "review-fix-loop",
  description: "Review-fix loop: parallel review (5 agents, 3+2 batched) → aggregate → fix → re-review until clean or max rounds. Per-run isolation via runId, state.json tracking, S1 conservative per-agent disable (2 consecutive clean → skip; any fix reactivates all).",
  phases: [
    { title: "Scan", detail: "Optional fallow static analysis pre-scan" },
    { title: "Review", detail: "Run review agents (skipping disabled ones) in 2 batches + aggregate" },
    { title: "Fix", detail: "Fix all must-fix issues from aggregated review report" },
  ],
};

// ── Constants & schemas ────────────────────────────────────────────

const DEFAULT_AGENT_TIMEOUT_MS = 1_800_000; // 30 min — current diff is 174 files / +29817 LOC; 10 min insufficient (wf-1781571544461 timed out twice)
const MODEL = "mimo-router/mimo-v2.5";
const CLEAN_THRESHOLD = 2; // S1: consecutive clean rounds to disable an agent

const reviewerSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to the written review report (.md)" },
    must_fix: { type: "number", description: "Number of must-fix issues found" },
    suggestion: { type: "number", description: "Number of suggestion-level issues found" },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

const aggregatorSchema = {
  type: "object",
  properties: {
    report_file: { type: "string", description: "Absolute path to aggregated.md" },
    must_fix: { type: "number", description: "Total must-fix after dedup across all dimensions" },
    suggestion: { type: "number", description: "Total suggestions after dedup across all dimensions" },
  },
  required: ["report_file", "must_fix", "suggestion"],
};

const AGENT_DEFS = [
  { name: "review-business-logic", title: "BUSINESS LOGIC REVIEW", report: "business-logic",
    focus: "business logic correctness, boundary conditions, regression risk." },
  { name: "review-monorepo-impact", title: "MONOREPO IMPACT REVIEW", report: "monorepo-impact",
    focus: "workspace deps, circular deps, public API changes, extension-dependencies.json." },
  { name: "review-type-safety", title: "TYPE SAFETY REVIEW", report: "type-safety",
    focus: "complete type annotations, no `any`, use `unknown` or concrete types, run tsc." },
  { name: "review-extension-api", title: "EXTENSION API REVIEW", report: "extension-api",
    focus: "tool/command schema completeness, Pi manifest, backward compat, resource containment." },
  { name: "review-test-coverage", title: "TEST COVERAGE REVIEW", report: "test-coverage",
    focus: "tests for new logic, edge case coverage, vitest framework compliance." },
];

// ── Per-run isolation: runId-scoped directories ────────────────────

const fs = require("fs");
const path = require("path");

const RUN_ID = ($ARGS._runId && typeof $ARGS._runId === "string")
  ? $ARGS._runId
  : "run-" + Date.now();
const RUN_ROOT = `/tmp/review-fix-loop/${RUN_ID}`;
const STATE_FILE = `${RUN_ROOT}/state.json`;

fs.mkdirSync(RUN_ROOT, { recursive: true });
log(`Run directory: ${RUN_ROOT}`);

// ── State management (persistent, atomic writes) ───────────────────

/**
 * state.json shape:
 * {
 *   meta: { runId, workspace, model, startedAt },
 *   agentStatus: { [agentName]: { consecutiveClean, disabled, lastActiveRound, lastMustFix } },
 *   rounds: [ { round, mustFix, suggestion, modifiedFiles?, agents: [ {name, must_fix, suggestion, clean} ] } ]
 * }
 */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  } catch {
    return {
      meta: { runId: RUN_ID, workspace: $WORKSPACE || "", model: MODEL, startedAt: new Date().toISOString() },
      agentStatus: {},
      rounds: [],
    };
  }
}

function saveState(state) {
  // Atomic write: tmp + rename to avoid partial reads mid-write.
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function recordAgentRound(state, agentName, mustFix, suggestion, round) {
  const clean = mustFix === 0;
  const status = state.agentStatus[agentName] || { consecutiveClean: 0, disabled: false, lastActiveRound: 0, lastMustFix: undefined };
  status.consecutiveClean = clean ? status.consecutiveClean + 1 : 0;
  status.disabled = status.consecutiveClean >= CLEAN_THRESHOLD;
  status.lastActiveRound = round;
  status.lastMustFix = mustFix;
  state.agentStatus[agentName] = status;
  return { ...status, cleanThisRound: clean };
}

function reactivateAll(state) {
  // S1 conservative: any fix reactivates all disabled agents.
  for (const name of Object.keys(state.agentStatus)) {
    const s = state.agentStatus[name];
    s.disabled = false;
    // Note: consecutiveClean is NOT reset — only re-disabled on next 2 consecutive cleans.
    // But since fix happened, the next review round's result will reset it naturally.
  }
}

function saveRoundSnapshot(state, round, mustFix, suggestion, agentResults, modifiedFiles) {
  state.rounds.push({
    round, mustFix, suggestion,
    agents: agentResults.map((a) => ({ name: a.name, must_fix: a.must_fix, suggestion: a.suggestion, clean: a.clean })),
    modifiedFiles: modifiedFiles || [],
  });
  saveState(state);
}

// ── Helpers ────────────────────────────────────────────────────────

function parseResult(raw) {
  if (typeof raw === "object" && raw !== null) return raw;
  if (typeof raw === "string") {
    // Strip markdown code fences (```json ... ```) — common LLM failure mode.
    let s = raw.trim();
    const fence = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/i);
    if (fence) s = fence[1].trim();
    // If surrounded by prose, extract the outermost JSON object.
    if (!s.startsWith("{") && !s.startsWith("[")) {
      const first = s.indexOf("{");
      const last = s.lastIndexOf("}");
      if (first !== -1 && last > first) s = s.slice(first, last + 1);
    }
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return null;
}

function normalizeAggregatorResult(raw) {
  const parsed = parseResult(raw);
  if (!parsed) return null;
  const mustFix =
    typeof parsed.must_fix === "number" ? parsed.must_fix :
    typeof parsed.totalMustFix === "number" ? parsed.totalMustFix :
    typeof parsed.mustFix === "number" ? parsed.mustFix : undefined;
  const suggestion =
    typeof parsed.suggestion === "number" ? parsed.suggestion :
    typeof parsed.totalSuggestions === "number" ? parsed.totalSuggestions :
    typeof parsed.suggestions === "number" ? parsed.suggestions : 0;
  if (typeof mustFix !== "number") return null;
  return { report_file: parsed.report_file || parsed.reportFile, must_fix: mustFix, suggestion };
}

// Fallback: aggregator agent sometimes writes aggregated.md correctly but
// returns malformed JSON. Recover must_fix/suggestion counts from the file
// so the loop can still reach the clean gate. Format produced by aggregator:
//   "## Summary\n- Must-fix: 0\n- Suggestions: 12\n- Infos: 17"
function parseAggregatedMd(content) {
  const mustFixMatch = content.match(/[-*]\s*Must[-_]fix\s*[:：]\s*(\d+)/i);
  if (!mustFixMatch) return null;
  const suggestionMatch = content.match(/[-*]\s*Suggestions?\s*[:：]\s*(\d+)/i);
  return {
    must_fix: parseInt(mustFixMatch[1], 10),
    suggestion: suggestionMatch ? parseInt(suggestionMatch[1], 10) : 0,
  };
}

// ── Build review agent calls (respecting disabled agents) ─────────

function buildReviewCalls(round, max, roundDir, fallowSummary, disabledSet) {
  const header = `Round ${round}/${max}`;
  const diffCmd = "Review \`git diff main...HEAD\` for all changes against main.";
  const fallowCtx = fallowSummary ? "\nFallow pre-scan context: " + fallowSummary : "";

  const baseCall = (def) => ({
    prompt: [header + " — " + def.title, "", diffCmd,
      "Focus: " + def.focus,
      "Write report to: " + roundDir + "/" + def.report + ".md" + fallowCtx].join("\n"),
    agent: def.name,
    model: MODEL,
    schema: reviewerSchema,
    description: def.name + "-round-" + round,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  });

  return AGENT_DEFS
    .filter((def) => !disabledSet.has(def.name))
    .map(baseCall);
}

// ── Main Loop ──────────────────────────────────────────────────────

const MAX = $ARGS.maxRounds ?? 10;
const STUCK_THRESHOLD = 3;
const SKIP_FALLOW = $ARGS.skipFallow ?? false;
const state = loadState();
let totalFixed = 0;
let round = 0;
let clean = false;
let stuckCount = 0;
let prevTotal = -1;

// Optional fallow scan (once before first round)
let fallowSummary = "";
if (!SKIP_FALLOW) {
  phase("Scan");
  try {
    const fallowRaw = await agent({
      prompt: [
        "Fallow pre-scan for review-fix-loop.",
        "",
        "Steps:",
        "1. Check if fallow is installed: `which fallow`",
        "2. If installed, run: `fallow audit --base main --format json --quiet`",
        "3. Extract: complexity hotspots, dead code, unused exports, circular deps",
        "4. Write summary to " + RUN_ROOT + "/fallow-scan.md",
        "5. If fallow not installed, write a one-line note and skip",
      ].join("\n"),
      description: "fallow-prescan",
      model: MODEL,
    });
    const fr = parseResult(fallowRaw);
    if (fr) fallowSummary = fr.summary || fr.output || "";
    if (fallowSummary) log("Fallow scan: " + fallowSummary);
  } catch {
    log("Fallow scan skipped.");
  }
}

while (round < MAX) {
  round++;
  log(`--- Round ${round}/${MAX} ---`);

  // ── Determine disabled agents (S1 conservative) ──────────
  const disabledSet = new Set(
    Object.entries(state.agentStatus)
      .filter(([, s]) => s.disabled)
      .map(([name]) => name)
  );
  if (disabledSet.size > 0) {
    log("Disabled agents (clean ≥ " + CLEAN_THRESHOLD + " consecutive): " + [...disabledSet].join(", "));
  }

  // ── Phase: Review (batched 3+2, only active agents) ──────
  phase("Review");
  const roundDir = `${RUN_ROOT}/round-${round}`;
  fs.mkdirSync(roundDir, { recursive: true });
  const allCalls = buildReviewCalls(round, MAX, roundDir, fallowSummary, disabledSet);

  if (allCalls.length === 0) {
    log("All agents disabled but code not clean — reactivating all for safety.");
    reactivateAll(state);
    saveState(state);
    continue; // restart this round with all agents active
  }

  // Batch 1: first 3 agents of active set
  log("Review batch 1/2 (3 agents)...");
  const batch1 = await parallel(allCalls.slice(0, 3));
  // Batch 2: remaining agents
  log("Review batch 2/2 (2 agents)...");
  const batch2 = await parallel(allCalls.slice(3));

  // Parse results, tolerate individual failures
  const allRaw = [...batch1, ...batch2];
  const reviewResults = [];
  const agentRoundResults = [];
  for (let i = 0; i < allRaw.length; i++) {
    const parsed = parseResult(allRaw[i]);
    if (parsed && typeof parsed.must_fix === "number") {
      reviewResults.push(parsed);
      const def = allCalls[i]; // allCalls[i] corresponds to allRaw[i] via baseCall mapping
      const recorded = recordAgentRound(state, def.agent, parsed.must_fix, parsed.suggestion ?? 0, round);
      agentRoundResults.push({ name: def.agent, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0, clean: recorded.cleanThisRound });
    } else {
      log("  ⚠ " + allCalls[i].description + " failed, skipping.");
    }
  }
  log(`Reviews: ${reviewResults.length}/${allCalls.length} succeeded.`);

  if (reviewResults.length === 0) {
    log("All review agents failed, stopping.");
    saveState(state);
    break;
  }

  // ── Aggregate ────────────────────────────────────────────
  const aggRaw = await agent({
    prompt: [
      `Round ${round}/${MAX} — AGGREGATE REVIEWS`,
      "",
      "You have TWO outputs to produce: (1) a markdown report file and (2) a JSON return value.",
      "",
      "Sub-review results: " + JSON.stringify(reviewResults, null, 2),
      "outputDir: " + roundDir,
      "",
      "─── PART 1: WRITE FILE ────────────────────────────────────",
      "Write the human-readable aggregated report to:",
      roundDir + "/aggregated.md",
      "",
      "Top section MUST be:",
      "```",
      "## Summary",
      "- Must-fix: <N>",
      "- Suggestions: <N>",
      "- Infos: <N>",
      "- Dimensions reviewed: <comma-separated>",
      "- Dedup: <N> duplicates removed",
      "```",
      "",
      "Followed by tables of Suggestions, Infos, and a Conclusion section.",
      "The format `- Must-fix: N` and `- Suggestions: N` is critical: a fallback parser depends on it.",
      "",
      "─── PART 2: RETURN JSON (CRITICAL — loop reads THIS) ─────",
      "Your FINAL response MUST be a single JSON object and NOTHING ELSE.",
      "",
      "Required shape (exact field names, no aliases, no extras):",
      "{",
      `  "report_file": "${roundDir}/aggregated.md",`,
      '  "must_fix": <integer>,',
      '  "suggestion": <integer>',
      "}",
      "",
      "STRICT RULES:",
      "- Field names MUST be exactly: report_file, must_fix, suggestion",
      "  (NOT mustFix, totalMustFix, count, totalMustFixCount, etc.)",
      "- must_fix and suggestion MUST be integers (0, 3, 12) — NOT strings, NOT null, NOT undefined",
      "- The JSON object MUST be the ONLY thing in your final response",
      "- DO NOT wrap in markdown code fences (no ```json blocks)",
      "- DO NOT add prose before/after the JSON (no 'Here is the report:', no explanation)",
      "- DO NOT add fields beyond the three listed",
      "",
      "─── SELF-CHECK before returning ──────────────────────────",
      "1. Did you write " + roundDir + "/aggregated.md? If not, do it first.",
      "2. Is must_fix in your JSON equal to the 'Must-fix: N' in your markdown?",
      "3. Is suggestion in your JSON equal to the 'Suggestions: N' in your markdown?",
      "4. Is your final response the bare JSON object, no fences, no prose?",
      "If any check fails, fix and re-output. The loop breaks on malformed JSON.",
    ].join("\n"),
    agent: "review-aggregator",
    model: MODEL,
    schema: aggregatorSchema,
    description: `aggregate-round-${round}`,
    timeoutMs: DEFAULT_AGENT_TIMEOUT_MS,
  });

  let agg = normalizeAggregatorResult(aggRaw);

  // Defense-in-depth: aggregator prompt now enforces JSON shape strictly
  // and parseResult strips code fences, so this fallback should rarely fire.
  // Kept as belt-and-suspenders against LLM regression.
  if (!agg || typeof agg.must_fix !== "number") {
    const rawPreview = (typeof aggRaw === "string" ? aggRaw : JSON.stringify(aggRaw)).slice(0, 200);
    log("Aggregator JSON invalid (len=" + (aggRaw?.length ?? 0) + "): " + rawPreview);

    const fallbackPath = (agg && agg.report_file) || (roundDir + "/aggregated.md");
    try {
      const content = fs.readFileSync(fallbackPath, "utf-8");
      const parsed = parseAggregatedMd(content);
      if (parsed && typeof parsed.must_fix === "number") {
        agg = { report_file: fallbackPath, must_fix: parsed.must_fix, suggestion: parsed.suggestion ?? 0 };
        log("Fallback parsed from " + fallbackPath + ": must_fix=" + agg.must_fix + ", suggestion=" + agg.suggestion);
      } else {
        log("Fallback parse: no Must-fix line in " + fallbackPath);
      }
    } catch (e) {
      log("Fallback read failed: " + e.message);
    }

    if (!agg || typeof agg.must_fix !== "number") {
      log("Aggregator failed and fallback failed, stopping.");
      saveState(state);
      break;
    }
  }

  const mustFix = agg.must_fix;
  const suggestion = agg.suggestion ?? 0;
  log(`Aggregated: ${mustFix} must-fix + ${suggestion} suggestion(s).`);

  // Save snapshot (before fix; modifiedFiles filled after fix)
  const currentRoundSnapshot = { round, mustFix, suggestion, agents: agentRoundResults, modifiedFiles: [] };

  // ── Gate: clean? ─────────────────────────────────────────
  if (mustFix === 0) {
    clean = true;
    log("Code is clean!");
    state.rounds.push(currentRoundSnapshot);
    saveState(state);
    break;
  }

  // ── Stuck detection ──────────────────────────────────────
  const total = mustFix + suggestion;
  if (prevTotal >= 0 && total >= prevTotal) {
    stuckCount++;
    if (stuckCount >= STUCK_THRESHOLD) {
      log(`Stuck: total issues not decreasing for ${STUCK_THRESHOLD} rounds. Stopping.`);
      state.rounds.push(currentRoundSnapshot);
      saveState(state);
      break;
    }
  } else {
    stuckCount = 0;
  }
  prevTotal = total;

  // ── Phase: Fix ───────────────────────────────────────────
  phase("Fix");

  let reportContent;
  try {
    reportContent = fs.readFileSync(agg.report_file, "utf-8");
  } catch {
    reportContent = "(could not read aggregated report)";
  }

  // Capture files changed by fix for snapshot
  function getChangedFiles() {
    try {
      const out = require("child_process").execSync(
        "git diff --name-only HEAD", { encoding: "utf-8", timeout: 10_000 }
      ).trim();
      return out ? out.split("\n") : [];
    } catch { return []; }
  }
  const filesBefore = new Set(getChangedFiles());

  const fxRaw = await agent({
    prompt: [
      `Fix round ${round}: Fix ALL must-fix issues from the aggregated review report below.`,
      "",
      "## Aggregated Review Report",
      reportContent,
      "",
      "## Instructions",
      "- Fix every must-fix issue listed in the report",
      "- Apply the MINIMAL correct fix (no refactoring, no style changes)",
      "- Verify each fix by reading the changed file afterwards",
      "- After all fixes, commit with message: `fix: review round " + round + " — " + mustFix + " must-fix`",
      "",
      "Return the count of issues fixed.",
    ].join("\n"),
    schema: {
      type: "object",
      properties: {
        fixed_count: { type: "number", description: "Number of issues fixed" },
        fixes: { type: "array", items: { type: "string" }, description: "One-line description of each fix" },
      },
      required: ["fixed_count"],
    },
    model: MODEL,
    description: `fix-round-${round}`,
  });

  const fx = parseResult(fxRaw);
  if (!fx) {
    log("Fix agent failed, stopping.");
    state.rounds.push(currentRoundSnapshot);
    saveState(state);
    break;
  }

  const fixedCount = fx.fixed_count ?? mustFix;
  totalFixed += fixedCount;

  // S1: any fix reactivates all agents (conservative — fix may have introduced regressions)
  const filesAfter = getChangedFiles();
  const modifiedFiles = filesAfter.filter((f) => !filesBefore.has(f));
  currentRoundSnapshot.modifiedFiles = modifiedFiles;
  state.rounds.push(currentRoundSnapshot);
  reactivateAll(state);
  saveState(state);

  log(`Fixed ${fixedCount} issue(s). Total: ${totalFixed}. Modified ${modifiedFiles.length} file(s). Continuing...`);
}

log("\n=== Loop Complete ===");
saveState(state);

return {
  rounds: round,
  maxRounds: MAX,
  totalFixed,
  clean,
  runDir: RUN_ROOT,
  message: clean
    ? `Code clean after ${round} round(s). ${totalFixed} issue(s) fixed total. State: ${STATE_FILE}`
    : `Stopped after ${round} round(s). ${totalFixed} issue(s) fixed. State: ${STATE_FILE}`,
};
