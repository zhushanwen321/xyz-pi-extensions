// packages/evolve-daily/src/index.ts

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { createCompactDetector } from "./detectors/compact";
import { createGoalQualityDetector } from "./detectors/goal-quality";
import { createParamErrorDetector } from "./detectors/param-error";
import { createSubagentDetector } from "./detectors/subagent-result";
import { PROBLEM_REGISTRY } from "./problems";
import { createTracker } from "./trackers/core";
import { skillExecutionConfig } from "./trackers/skill-execution";

// 资源文件（Python 脚本）相对于扩展目录自身定位，不依赖外部绝对路径
const EXT_DIR = dirname(fileURLToPath(import.meta.url)); // src/
const ANALYZER_PATH = join(EXT_DIR, "..", "analyzer", "analyze.py");

// 运行时数据目录使用 Pi 平台约定路径（homedir + .pi/agent/）
const REPORTS_DIR = join(homedir(), ".pi", "agent", "evolution-data", "daily-reports");

const DATE_SLICE_END = 10;
const ANALYZER_TIMEOUT_MS = 30_000;
/** 回溯填补最多 7 天的缺失/空报告 */
const BACKFILL_MAX_DAYS = 7;

/** Pi API 的 on 方法重载签名（覆盖非标事件名） */
type PiOnAny = { on(event: string, handler: (...args: unknown[]) => Promise<void> | void): void };

/** tool_result 事件中匹配的工具结果 detector */
interface ToolResultDetector {
  problemId: string;
  match(event: Record<string, unknown>): boolean;
  createItem(event: Record<string, unknown>): { id: string; problemId: string; status: string; detail?: string };
}

export default function evolveDailyExtension(pi: ExtensionAPI) {
  // ── L1: session_start 时调用 Python analyzer ──
  // 分析前一天的数据（session_start 时当天的 session 刚开始，有意义的数据是昨天的）
  // 并回溯填补最近 BACKFILL_MAX_DAYS 天内缺失或空（session_count=0）的报告
  /** 每天毫秒数 */
  const MS_PER_DAY = 86_400_000;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    // 收集需要（重新）生成的日期
    const datesToAnalyze: string[] = [];
    for (let i = 1; i <= BACKFILL_MAX_DAYS; i++) {
      const date = new Date(Date.now() - i * MS_PER_DAY)
        .toISOString()
        .slice(0, DATE_SLICE_END);
      const reportPath = join(REPORTS_DIR, `${date}.json`);

      if (!existsSync(reportPath)) {
        datesToAnalyze.push(date);
        continue;
      }

      // 空报告（session_count=0）允许重跑：可能是 off-by-one bug 或当天过早运行导致
      try {
        const content = readFileSync(reportPath, "utf-8");
        const report = JSON.parse(content) as { session_count?: number };
        if ((report.session_count ?? 0) === 0) {
          datesToAnalyze.push(date);
        }
      } catch {
        // 解析失败也重新生成
        datesToAnalyze.push(date);
      }
    }

    if (datesToAnalyze.length === 0) return;

    for (const date of datesToAnalyze) {
      const reportPath = join(REPORTS_DIR, `${date}.json`);
      try {
        await pi.exec(
          "python3",
          [
            ANALYZER_PATH,
            "--date",
            date,
            "--format",
            "json",
            "--output",
            reportPath,
          ],
          { timeout: ANALYZER_TIMEOUT_MS, signal: ctx.signal }
        );
      } catch (e) {
        try {
          unlinkSync(reportPath);
        // eslint-disable-next-line taste/no-silent-catch
        } catch {
          /* already gone */
        }
        console.error(`[evolve-daily] analyzer failed for ${date}:`, e);
      }
    }
  });

  // ── L2c: Tracker 主动追踪（createTracker 在闭包内调用） ──
  createTracker(pi, skillExecutionConfig);

  // ── L2a: Compact 实时追踪 — 监听 session_compact 事件 ──
  const compactDetector = createCompactDetector(
    PROBLEM_REGISTRY.find((p) => p.id === "compact-frequency")!
  );

  (pi as unknown as PiOnAny).on("session_compact", async (event: unknown) => {
    const ev = event as Record<string, unknown>;
    try {
      const item = compactDetector.createItem(ev);
      pi.appendEntry("evolve-feedback", {
        problemId: item.problemId,
        itemId: item.id,
        status: item.status,
        detail: item.detail ?? null,
        timestamp: new Date().toISOString(),
      });
    // eslint-disable-next-line taste/no-silent-catch
    } catch (e) {
      console.error(
        `[evolve-daily] compact detector error:`,
        e
      );
    }
  });

  // ── L2b: 工具结果实时追踪 — 监听 tool_result 事件 ──
  // subagent/param-error/goal-quality detectors 检查 event.type === "tool_result"
  const toolDetectors: ToolResultDetector[] = [
    createSubagentDetector(
      PROBLEM_REGISTRY.find((p) => p.id === "subagent-efficiency")!
    ),
    createParamErrorDetector(
      PROBLEM_REGISTRY.find((p) => p.id === "tool-param-validation")!
    ),
    createGoalQualityDetector(
      PROBLEM_REGISTRY.find((p) => p.id === "goal-task-quality")!
    ),
  ];

  (pi as unknown as PiOnAny).on(
    "tool_result",
    async (event: unknown, _ctx?: unknown) => {
      const ev = event as Record<string, unknown>;
      for (const detector of toolDetectors) {
        try {
          if (detector.match(ev)) {
            const item = detector.createItem(ev);
            pi.appendEntry("evolve-feedback", {
              problemId: item.problemId,
              itemId: item.id,
              status: item.status,
              detail: item.detail ?? null,
              timestamp: new Date().toISOString(),
            });
          }
        // eslint-disable-next-line taste/no-silent-catch
        } catch (e) {
          console.error(
            `[evolve-daily] detector ${detector.problemId} error:`,
            e
          );
        }
      }
    }
  );
}
