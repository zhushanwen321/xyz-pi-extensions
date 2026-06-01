import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ANALYZER_PATH = join(
  homedir(),
  ".pi/agent/scripts/pi-session-analyzer/analyze.py"
);
// daily-reports/ 目录复用旧 extension 的目录路径。
// 旧 extension 写入 .md 文件，新 evolve-daily 写入 .json 文件，天然不冲突。
// 删除旧 extension 后残留的 .md 文件可忽略。
const REPORTS_DIR = join(homedir(), ".pi/agent/evolution-data/daily-reports");

export default function evolveDailyExtension(pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const reportPath = join(REPORTS_DIR, `${today}.json`);

    if (existsSync(reportPath)) return;

    try {
      await pi.exec(
        "python3",
        [ANALYZER_PATH, "--since", "1d", "--format", "json", "--output", reportPath],
        { timeout: 30_000 }
      );
    } catch (e) {
      // Clean up partial output if analyzer failed mid-write
      try { unlinkSync(reportPath); } catch { /* already gone */ }
      console.error("[evolve-daily] analyzer failed:", e);
    }
  });
}
