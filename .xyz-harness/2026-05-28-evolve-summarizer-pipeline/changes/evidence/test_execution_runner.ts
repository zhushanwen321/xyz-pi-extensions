/**
 * Phase 4 Test Execution — Evolve Summarizer Pipeline
 *
 * Runs integration test cases from test_cases_template.json by importing
 * evolution-engine modules directly via tsx.
 *
 * Usage: npx tsx test_execution_runner.ts
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// ── Paths ──────────────────────────────────────────────────────

const __dirname = join(fileURLToPath(import.meta.url), "..");
const PROJECT_ROOT = join(__dirname, "..", "..", "..", "..");
const EVOLUTION_SRC = join(PROJECT_ROOT, "evolution-engine", "src");

// ── Test Result Aggregator ─────────────────────────────────────

interface TestResult {
	caseId: string;
	round: number;
	passed: boolean;
	execute_steps: string[];
	evidence: string;
}

const results: TestResult[] = [];
const ROUND = 1;

function record(caseId: string, passed: boolean, steps: string[], evidence: string): void {
	results.push({ caseId, round: ROUND, passed, execute_steps: steps, evidence });
	console.log(`  ${passed ? "✅" : "❌"} ${caseId}: ${passed ? "PASS" : "FAIL"}`);
	if (!passed) console.log(`     ${evidence}`);
}

// ── Temp Dir Setup ─────────────────────────────────────────────

const TMP_BASE = join(tmpdir(), `evolve-test-${randomUUID()}`);
const evolutionDir = join(TMP_BASE, "evolution-data");
const reportsDir = join(evolutionDir, "reports");
const signalsDir = join(evolutionDir, "signals");
const dailyDir = join(evolutionDir, "daily");
const suggestionsDir = join(evolutionDir, "suggestions");
const tmpDir = join(evolutionDir, "tmp");
const historyPath = join(evolutionDir, "history.jsonl");
const metricsHistoryPath = join(evolutionDir, "metrics-history.json");

function setupDirs(): void {
	for (const d of [reportsDir, signalsDir, dailyDir, suggestionsDir, tmpDir]) {
		mkdirSync(d, { recursive: true });
	}
}

function cleanup(): void {
	try { rmSync(TMP_BASE, { recursive: true, force: true }); } catch { /* ok */ }
}

function writeJson(filePath: string, data: unknown): void {
	writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function readJson<T>(filePath: string): T {
	return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log("🧪 Evolve Summarizer Pipeline — Phase 4 Test Execution\n");
	setupDirs();

	const HOME = process.env.HOME ?? "/Users/zhushanwen";
	const realReportPath = join(HOME, ".pi/agent/evolution-data/reports/retrospective-2026-05-27.json");

	// ── Import modules (after dirs exist for side-effects like ensureDir) ──
	const { extractMetricsSnapshot, summarizeReport, detectAnomalies, computeTrends } = await import(
		join(EVOLUTION_SRC, "summarizer.js")
	);
	const { buildEffectReview } = await import(join(EVOLUTION_SRC, "effect-tracker.js"));
	const { runGc } = await import(join(EVOLUTION_SRC, "gc.js"));

	// ════════════════════════════════════════════════════════════════
	// TC-8-01: TypeScript type check
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-8-01: tsc --noEmit ---");
	let tscPassed = false;
	let tscEvidence = "";
	try {
		execFileSync("npx", ["tsc", "--noEmit"], {
			cwd: EVOLUTION_SRC,
			encoding: "utf-8",
			timeout: 30000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		tscPassed = true;
		tscEvidence = "exit 0, no errors";
	} catch (e: unknown) {
		const err = e as { stderr?: string; stdout?: string; status?: number };
		tscEvidence = `exit ${err.status}: ${(err.stderr ?? err.stdout ?? "").slice(0, 200)}`;
	}
	record("TC-8-01", tscPassed, [`npx tsc --noEmit in ${EVOLUTION_SRC}`], tscEvidence);

	// ════════════════════════════════════════════════════════════════
	// TC-9-01: ESLint
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-9-01: ESLint ---");
	let lintPassed = false;
	let lintEvidence = "";
	function checkLintErrors(output: string): { ok: boolean; msg: string } {
		const errors = output.split("\n").filter(l => l.includes("error"));
		const evoErrors = errors.filter(l => l.includes("evolution-engine"));
		if (evoErrors.length > 0) return { ok: false, msg: `evolution-engine has ${evoErrors.length} lint error(s)` };
		if (errors.length > 0) return { ok: true, msg: `${errors.length} error(s) in other packages only (pre-existing)` };
		return { ok: true, msg: "0 lint errors" };
	}
	try {
		const out = execFileSync("npm", ["run", "lint", "--silent"], {
			cwd: PROJECT_ROOT,
			encoding: "utf-8",
			timeout: 30000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const result = checkLintErrors(out);
		lintPassed = result.ok;
		lintEvidence = result.msg;
	} catch (e: unknown) {
		const err = e as { stderr?: string; stdout?: string; status?: number };
		const output = (err.stdout ?? err.stderr ?? "");
		const result = checkLintErrors(output);
		lintPassed = result.ok;
		lintEvidence = `npm exit ${err.status}: ${result.msg}`;
	}
	record("TC-9-01", lintPassed, ["npm run lint in project root"], lintEvidence);

	// ════════════════════════════════════════════════════════════════
	// TC-1-01: Summarizer compression
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-1-01: summarizer compresses to <= 15KB ---");
	let tc1_1_passed = false;
	let tc1_1_evidence = "";
	if (existsSync(realReportPath)) {
		try {
			const rawReport = readJson<Record<string, unknown>>(realReportPath);
			const rawSizeKB = Buffer.byteLength(JSON.stringify(rawReport)) / 1024;
			const result = summarizeReport(rawReport, [], evolutionDir, realReportPath);
			const resultSize = Buffer.byteLength(JSON.stringify(result));
			tc1_1_passed = resultSize <= 15 * 1024;
			const ratio = (resultSize / (rawSizeKB * 1024) * 100).toFixed(1);
			tc1_1_evidence = tc1_1_passed
				? `Raw: ${rawSizeKB.toFixed(0)}KB → Signal: ${(resultSize / 1024).toFixed(1)}KB (${ratio}%)`
				: `Raw: ${rawSizeKB.toFixed(0)}KB → Signal: ${(resultSize / 1024).toFixed(1)}KB > 15KB`;
		} catch (e: unknown) {
			tc1_1_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	} else {
		tc1_1_evidence = "Skipped: real report not found";
	}
	record("TC-1-01", tc1_1_passed, [
		`read real report (${realReportPath})`,
		"call summarizeReport(report, [])",
		"assert output size <= 15360 bytes",
	], tc1_1_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-1-02: extractMetricsSnapshot
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-1-02: extractMetricsSnapshot ---");
	let tc1_2_passed = false;
	let tc1_2_evidence = "";
	if (existsSync(realReportPath)) {
		try {
			const rawReport = readJson<Record<string, unknown>>(realReportPath);
			const snapshot = extractMetricsSnapshot(rawReport);
			const checks = [
				snapshot.sessionCount > 0,
				snapshot.totalToolCalls >= 0,
				snapshot.bashFailureRate >= 0 && snapshot.bashFailureRate <= 1,
				snapshot.totalInputTokens >= 0,
				snapshot.activeSkillCount >= 0,
				typeof snapshot.date === "string" && snapshot.date.length === 10,
			];
			tc1_2_passed = checks.every(Boolean);
			tc1_2_evidence = tc1_2_passed
				? `sessions=${snapshot.sessionCount}, tools=${snapshot.totalToolCalls}, bashFail=${(snapshot.bashFailureRate * 100).toFixed(1)}%, skills=${snapshot.activeSkillCount}, date=${snapshot.date}`
				: `Checks: ${checks.map((c, i) => `${i}:${c}`).join(", ")}`;
		} catch (e: unknown) {
			tc1_2_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
		}
	} else {
		tc1_2_evidence = "Skipped: real report not found";
	}
	record("TC-1-02", tc1_2_passed, [
		`read ${realReportPath}`,
		"call extractMetricsSnapshot(report)",
		"assert all numeric fields >= 0",
	], tc1_2_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-1-03: Anomaly detection — tool failure
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-1-03: anomaly detection (tool failure) ---");
	let tc1_3_passed = false;
	let tc1_3_evidence = "";
	try {
		// detectAnomalies looks for by_tool[tool].error_rate
		const report: Record<string, unknown> = {
			_meta: { total_sessions: 10, analysis_period: { until: "2026-05-28" } },
			tool_stats: { total_calls: 100, edit_retry_rate: 0 },
			token_stats: { total_input: 0, total_output: 0, cost_total: 0, avg_per_session: { input: 0, output: 0 } },
			error_stats: {
				bash_failure_rate: 0.15,
				self_correction_rate: 0,
				by_tool: { bash: { calls: 100, failures: 15, error_rate: 0.35 } }, // >30% = medium
			},
			user_patterns: { corrections: { rate: 0 }, repeated_requests: [] },
			satisfaction: {
				single_turn_completion_rate: 0,
				avg_turns_per_session: 0,
				avg_tool_calls_per_session: 0,
				session_duration_stats: { median_minutes: 0 },
			},
			skill_stats: { triggered_skills: {}, never_triggered: [], skill_file_sizes: {} },
		};
		const result = detectAnomalies(report);
		tc1_3_passed = result.some((a) => a.type === "tool_failure" && a.severity === "medium");
		tc1_3_evidence = tc1_3_passed
			? `Found tool_failure: ${JSON.stringify(result.find(a => a.type === 'tool_failure'))}`
			: `No anomaly. Got: ${JSON.stringify(result)}`;
	} catch (e: unknown) {
		tc1_3_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-1-03", tc1_3_passed, [
		"construct report with by_tool.bash.error_rate=0.35",
		"call detectAnomalies(report)",
		"assert tool_failure severity='medium' (>=30%, <50%)",
	], tc1_3_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-1-04: Anomaly detection — dormant skills
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-1-04: anomaly detection (dormant skills) ---");
	let tc1_4_passed = false;
	let tc1_4_evidence = "";
	try {
		// detectAnomalies checks neverTriggered.length > 10
		const dormant = Array.from({ length: 12 }, (_, i) => `skill-${i}`);
		const report: Record<string, unknown> = {
			_meta: { total_sessions: 50, analysis_period: { until: "2026-05-28" } },
			tool_stats: { total_calls: 0, edit_retry_rate: 0 },
			token_stats: { total_input: 0, total_output: 0, cost_total: 0, avg_per_session: { input: 0, output: 0 } },
			error_stats: { bash_failure_rate: 0, self_correction_rate: 0, by_tool: {} },
			user_patterns: { corrections: { rate: 0 }, repeated_requests: [] },
			satisfaction: {
				single_turn_completion_rate: 0,
				avg_turns_per_session: 0,
				avg_tool_calls_per_session: 0,
				session_duration_stats: { median_minutes: 0 },
			},
			skill_stats: {
				triggered_skills: {},
				never_triggered: dormant,
				skill_file_sizes: Object.fromEntries(dormant.map((s: string) => [s, 100])),
			},
		};
		const result = detectAnomalies(report);
		tc1_4_passed = result.some((a) => a.type === "dormant_skill");
		tc1_4_evidence = tc1_4_passed
			? `Found dormant_skill: ${JSON.stringify(result.find(a => a.type === 'dormant_skill'))}`
			: `No dormant skill anomaly. Got: ${JSON.stringify(result)}`;
	} catch (e: unknown) {
		tc1_4_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-1-04", tc1_4_passed, [
		"construct report with 12 never_triggered skills",
		"call detectAnomalies(report)",
		"assert dormant_skill anomaly detected (threshold >10)",
	], tc1_4_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-2-01: Metrics history sliding window
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-2-01: metrics history sliding window ---");
	let tc2_1_passed = false;
	let tc2_1_evidence = "";
	try {
		type MetricsSnapshot = ReturnType<typeof extractMetricsSnapshot>;
		const baseSnapshot: MetricsSnapshot = {
			date: "2026-05-01", sessionCount: 0, totalToolCalls: 0,
			toolFailureRates: {}, editRetryRate: 0, bashFailureRate: 0,
			singleTurnCompletionRate: 0, avgTurnsPerSession: 0, avgToolCallsPerSession: 0,
			selfCorrectionRate: 0, totalInputTokens: 0, totalOutputTokens: 0,
			totalCost: 0, avgInputPerSession: 0, avgOutputPerSession: 0,
			userCorrectionRate: 0, repeatedRequestCount: 0, medianSessionMinutes: 0,
			activeSkillCount: 0, dormantSkillCount: 0, totalSkillFileSize: 0,
		};

		for (let i = 0; i < 31; i++) {
			const date = new Date("2026-05-01");
			date.setDate(date.getDate() + i);
			const snapshot: MetricsSnapshot = { ...baseSnapshot, date: date.toISOString().slice(0, 10), sessionCount: i };
			// Use saveMetricsSnapshot from state — call like: saveMetricsSnapshot(evolutionDir, snapshot)
			// But since we have summarizer instead, inline the logic:
			const { saveMetricsSnapshot } = await import(
				join(EVOLUTION_SRC, "state.js")
			);
			saveMetricsSnapshot(evolutionDir, snapshot);
		}

		const { loadMetricsHistory } = await import(
			join(EVOLUTION_SRC, "state.js")
		);
		const history = loadMetricsHistory(evolutionDir);
		const expectedOldest = "2026-05-02";
		tc2_1_passed = history.length === 30 && (history[0] as MetricsSnapshot).date === expectedOldest;
		tc2_1_evidence = tc2_1_passed
			? `Window: ${history.length} (expected 30), oldest=${(history[0] as MetricsSnapshot).date} (expected ${expectedOldest})`
			: `Length: ${history.length} (expected 30), oldest=${(history[0] as MetricsSnapshot)?.date} (expected ${expectedOldest})`;
	} catch (e: unknown) {
		tc2_1_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-2-01", tc2_1_passed, [
		"write 31 snapshots via saveMetricsSnapshot(evolutionDir, snapshot)",
		"call loadMetricsHistory(evolutionDir)",
		"assert length === 30, oldest is 2nd snapshot (sliding window)",
	], tc2_1_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-3-01: Trend delta ±20% threshold
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-3-01: trend delta threshold ---");
	let tc3_1_passed = false;
	let tc3_1_evidence = "";
	try {
		type MetricsSnapshot = ReturnType<typeof extractMetricsSnapshot>;
		const base: MetricsSnapshot = {
			date: "2026-05-26", sessionCount: 10, totalToolCalls: 100,
			toolFailureRates: {}, editRetryRate: 0, bashFailureRate: 0.10,
			singleTurnCompletionRate: 0.85, avgTurnsPerSession: 5, avgToolCallsPerSession: 10,
			selfCorrectionRate: 0.1, totalInputTokens: 100000, totalOutputTokens: 50000,
			totalCost: 0.5, avgInputPerSession: 10000, avgOutputPerSession: 5000,
			userCorrectionRate: 0.2, repeatedRequestCount: 5, medianSessionMinutes: 15,
			activeSkillCount: 20, dormantSkillCount: 3, totalSkillFileSize: 50000,
		};
		const prev = { ...base };
		const curr: MetricsSnapshot = {
			...base,
			date: "2026-05-27",
			bashFailureRate: 0.08,  // -20%, exactly at threshold
			editRetryRate: 0.05,    // from 0 → undefined change
			totalInputTokens: 95000, // -5%, below threshold
			userCorrectionRate: 0.15, // -25%, above threshold
		};
		const trends = computeTrends(curr, prev);
		const hasBashTrend = trends.some((t) => t.field === "bashFailureRate");
		const hasInputTrend = trends.some((t) => t.field === "totalInputTokens");
		tc3_1_passed = hasBashTrend && !hasInputTrend;
		tc3_1_evidence = tc3_1_passed
			? `bashFailureRate -20%: ✓, totalInputTokens (-5%): excluded ✓. Trends: ${trends.length} entries, fields: ${trends.map(t => t.field).join(", ")}`
			: `hasBashTrend=${hasBashTrend}, hasInputTrend=${hasInputTrend}. Trends: ${JSON.stringify(trends)}`;
	} catch (e: unknown) {
		tc3_1_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-3-01", tc3_1_passed, [
		"create prev/current snapshots with known deltas",
		"call computeTrends(current, previous)",
		"assert bashFailureRate -20% appears (>=10% threshold)",
		"assert totalInputTokens -5% excluded (<10% threshold)",
	], tc3_1_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-4-01: Effect review
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-4-01: effect review ---");
	let tc4_1_passed = false;
	let tc4_1_evidence = "";
	try {
		type MetricsSnapshot = ReturnType<typeof extractMetricsSnapshot>;
		const snapshots: MetricsSnapshot[] = [];
		const baseSnap: MetricsSnapshot = {
			date: "", sessionCount: 10, totalToolCalls: 100,
			toolFailureRates: {}, editRetryRate: 0, bashFailureRate: 0.10,
			singleTurnCompletionRate: 0.85, avgTurnsPerSession: 5, avgToolCallsPerSession: 10,
			selfCorrectionRate: 0.1, totalInputTokens: 100000, totalOutputTokens: 50000,
			totalCost: 0.5, avgInputPerSession: 10000, avgOutputPerSession: 5000,
			userCorrectionRate: 0.2, repeatedRequestCount: 5, medianSessionMinutes: 15,
			activeSkillCount: 20, dormantSkillCount: 3, totalSkillFileSize: 50000,
		};
		for (const d of ["2026-05-24", "2026-05-26", "2026-05-28"]) {
			snapshots.push({ ...baseSnap, date: d, bashFailureRate: d === "2026-05-28" ? 0.15 : 0.10 });
		}

		// Save snapshots to history so loadMetricsHistory can find them
		const { saveMetricsSnapshot } = await import(
			join(EVOLUTION_SRC, "state.js")
		);
		for (const s of snapshots) saveMetricsSnapshot(evolutionDir, s);

		// Re-load to get the same array buildEffectReview will use
		const { loadMetricsHistory } = await import(
			join(EVOLUTION_SRC, "state.js")
		);
		const loadedSnapshots = loadMetricsHistory(evolutionDir);

		// Write apply history jsonl (buildEffectReview reads from this)
		appendFileSync(historyPath, JSON.stringify({
			timestamp: "2026-05-26T12:00:00.000Z",
			action: "apply",
			suggestionId: "test",
			targetPath: "/tmp/test",
			backupPath: "/tmp/test.bak",
			diff: "",
			title: "Reduce bash failure rate",
			metricsSnapshotDate: "2026-05-25",
		}) + "\n", "utf-8");

		const historyEntries = [{
			timestamp: "2026-05-26T12:00:00.000Z",
			action: "apply" as const,
			suggestionId: "test",
			targetPath: "/tmp/test",
			backupPath: "/tmp/test.bak",
			diff: "",
			title: "Reduce bash failure rate",
			metricsSnapshotDate: "2026-05-25" as const,
		}];

		const effect = buildEffectReview(historyEntries, loadedSnapshots);
		tc4_1_passed = effect.length >= 1;
		tc4_1_evidence = tc4_1_passed
			? `Effect review found: ${effect.length} entries. First: before=${effect[0].before.date}, after=${effect[0].after.date}`
			: `No effect entries. Got ${effect.length}`;
	} catch (e: unknown) {
		tc4_1_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-4-01", tc4_1_passed, [
		"create 3 metrics snapshots (2026-05-24, 26, 28)",
		"create apply history entry with metricsSnapshotDate='2026-05-25'",
		"call buildEffectReview(history, snapshots)",
		"assert >= 1 effect entry with before/after",
	], tc4_1_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-5-01: GC removes old reports (keep newest 3)
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-5-01: GC report retention ---");
	let tc5_1_passed = false;
	let tc5_1_evidence = "";
	try {
		// Create 5 report files (stagger mtime by waiting a bit)
		const reportNames = [
			"retrospective-2026-05-27.json",
			"retrospective-2026-05-26.json",
			"retrospective-2026-05-25.json",
			"retrospective-2026-05-24.json",
			"retrospective-2026-05-23.json",
		];
		for (const name of reportNames) {
			writeJson(join(reportsDir, name), { _meta: { until: name.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "unknown" } });
		}

		const gcResult = runGc(evolutionDir);
		const remaining = readdirSync(reportsDir).filter(f => f.endsWith(".json"));

		tc5_1_passed = remaining.length === 3 && gcResult.reportsRemoved === 2;
		tc5_1_evidence = tc5_1_passed
			? `GC kept ${remaining.length} reports, removed ${gcResult.reportsRemoved}`
			: `Remaining: ${remaining.length} (expected 3), removed: ${gcResult.reportsRemoved} (expected 2)`;
	} catch (e: unknown) {
		tc5_1_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-5-01", tc5_1_passed, [
		"create 5 report JSON files",
		"call runGc(evolutionDir)",
		"assert reports/ has 3 files, reportsRemoved === 2",
	], tc5_1_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-5-02: GC daily retention (90 days)
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-5-02: GC daily retention 90 days ---");
	let tc5_2_passed = false;
	let tc5_2_evidence = "";
	try {
		writeJson(join(dailyDir, "2026-02-01.json"), {}); // >90 days old
		writeJson(join(dailyDir, "2026-05-27.json"), {}); // recent
		// Need an extra recent file to reduce to, otherwise GC might not find old ones
		writeJson(join(dailyDir, "2026-05-28.json"), {});

		runGc(evolutionDir);

		const remainingDaily = readdirSync(dailyDir).filter(f => f.endsWith(".json"));
		tc5_2_passed =
			!remainingDaily.includes("2026-02-01.json") &&
			remainingDaily.includes("2026-05-27.json");
		tc5_2_evidence = tc5_2_passed
			? `Old file deleted, recent files kept (${remainingDaily.join(", ")})`
			: `2026-02-01 present=${remainingDaily.includes("2026-02-01.json")}, 2026-05-27 present=${remainingDaily.includes("2026-05-27.json")}`;
	} catch (e: unknown) {
		tc5_2_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-5-02", tc5_2_passed, [
		"create old (>90 days) and recent daily JSON files",
		"call runGc(evolutionDir)",
		"assert old file deleted, recent retained",
	], tc5_2_evidence);

	// ════════════════════════════════════════════════════════════════
	// TC-7-01: Full pipeline (signal file creation)
	// ════════════════════════════════════════════════════════════════
	console.log("\n--- TC-7-01: full pipeline (signal) ---");
	let tc7_1_passed = false;
	let tc7_1_evidence = "";
	try {
		const syntheticReport: Record<string, unknown> = {
			_meta: { total_sessions: 50, analysis_period: { from: "2026-05-26", until: "2026-05-27" } },
			tool_stats: { total_calls: 500, edit_retry_rate: 0.03 },
			token_stats: {
				total_input: 500000, total_output: 200000, cost_total: 1.25,
				avg_per_session: { input: 10000, output: 4000 },
			},
			error_stats: { bash_failure_rate: 0.05, self_correction_rate: 0.2, by_tool: { edit: { calls: 200, failures: 6, error_rate: 0.03 } } },
			user_patterns: { corrections: { rate: 0.1 }, repeated_requests: ["req1", "req2"] },
			satisfaction: {
				single_turn_completion_rate: 0.75, avg_turns_per_session: 6,
				avg_tool_calls_per_session: 10, session_duration_stats: { median_minutes: 12 },
			},
			skill_stats: {
				triggered_skills: { "test-skill": { triggers: 5, avg_score: 0.8 } },
				never_triggered: ["dead-skill"],
				skill_file_sizes: { "test-skill": 1024, "dead-skill": 512 },
			},
		};
		const reportPath = join(reportsDir, "retrospective-2026-05-27.json");
		writeJson(reportPath, syntheticReport);

		const signal = summarizeReport(syntheticReport, [], evolutionDir, reportPath);
		const signalFilePath = join(signalsDir, `signal-${signal.metricsSnapshot.date}.json`);

		tc7_1_passed = existsSync(signalFilePath);
		tc7_1_evidence = tc7_1_passed
			? `Signal file created at ${signalFilePath}`
			: `Signal file NOT found at ${signalFilePath}`;
	} catch (e: unknown) {
		tc7_1_evidence = `Error: ${e instanceof Error ? e.message : String(e)}`;
	}
	record("TC-7-01", tc7_1_passed, [
		"create synthetic report with 50 sessions",
		"run summarizeReport pipeline",
		"verify signal-{date}.json created in signals/",
	], tc7_1_evidence);

	// ════════════════════════════════════════════════════════════════
	// Summary
	// ════════════════════════════════════════════════════════════════
	console.log("\n═══════════════════════════════════════════");
	console.log("📊 SUMMARY");
	console.log("═══════════════════════════════════════════");
	let pass = 0, fail = 0;
	for (const r of results) {
		if (r.passed) pass++;
		else fail++;
	}
	console.log(`  ✅ PASS: ${pass}`);
	console.log(`  ❌ FAIL: ${fail}`);
	console.log(`  Total:   ${pass + fail}`);
	console.log("═══════════════════════════════════════════\n");

	// ════════════════════════════════════════════════════════════════
	// Write test_execution.json
	// ════════════════════════════════════════════════════════════════
	const executionJsonPath = join(__dirname, "test_execution.json");
	writeJson(executionJsonPath, { test_execution: results });
	console.log(`📍 Results written to ${executionJsonPath}`);

	cleanup();
	if (fail > 0) {
		console.error(`❌ ${fail} test(s) failed`);
		process.exit(1);
	}
	console.log("🎉 All tests passed!");
}

main().catch((e) => {
	console.error("Fatal error:", e);
	cleanup();
	process.exit(1);
});
