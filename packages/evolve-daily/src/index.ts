// packages/evolve-daily/src/index.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PROBLEM_REGISTRY } from "./problems";
import { createCompactDetector } from "./detectors/compact";
import { createSubagentDetector } from "./detectors/subagent-result";
import { createParamErrorDetector } from "./detectors/param-error";
import { createGoalQualityDetector } from "./detectors/goal-quality";

const ANALYZER_PATH = join(
  __dirname,
  "..",
  "analyzer",
  "analyze.py"
);
// daily-reports/ 目录复用旧 extension 的目录路径。
// 旧 extension 写入 .md 文件，新 evolve-daily 写入 .json 文件，天然不冲突。
// 删除旧 extension 后残留的 .md 文件可忽略。
const REPORTS_DIR = join(homedir(), ".pi/agent/evolution-data/daily-reports");

/** tool_result 事件中匹配的工具结果 detector */
interface ToolResultDetector {
  problemId: string;
  match(event: Record<string, unknown>): boolean;
  createItem(event: Record<string, unknown>): { id: string; problemId: string; status: string; detail?: string };
}

export default function evolveDailyExtension(pi: ExtensionAPI) {
  // ── L1: session_start 时调用 Python analyzer ──
  pi.on("session_start", async () => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const reportPath = join(REPORTS_DIR, `${today}.json`);

    if (existsSync(reportPath)) return;

    try {
      await pi.exec(
        "python3",
        [
          ANALYZER_PATH,
          "--since",
          "1d",
          "--format",
          "json",
          "--output",
          reportPath,
        ],
        { timeout: 30_000 }
      );
    } catch (e) {
      // Clean up partial output if analyzer failed mid-write
      try {
        unlinkSync(reportPath);
      } catch {
        /* already gone */
      }
      console.error("[evolve-daily] analyzer failed:", e);
    }
  });

  // ── L2a: Compact 实时追踪 — 监听 session_compact 事件 ──
  const compactDetector = createCompactDetector(
    PROBLEM_REGISTRY.find((p) => p.id === "compact-frequency")!
  );

  pi.on("session_compact", async (event: Record<string, unknown>) => {
    try {
      const item = compactDetector.createItem(event);
      pi.appendEntry("evolve-feedback", {
        problemId: item.problemId,
        itemId: item.id,
        status: item.status,
        detail: item.detail ?? null,
        timestamp: new Date().toISOString(),
      });
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

  pi.on(
    "tool_result",
    async (event: Record<string, unknown>, _ctx?: unknown) => {
      for (const detector of toolDetectors) {
        try {
          if (detector.match(event)) {
            const item = detector.createItem(event);
            pi.appendEntry("evolve-feedback", {
              problemId: item.problemId,
              itemId: item.id,
              status: item.status,
              detail: item.detail ?? null,
              timestamp: new Date().toISOString(),
            });
          }
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
