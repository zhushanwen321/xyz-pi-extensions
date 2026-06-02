import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 资源文件（Python 脚本）相对于扩展目录自身定位，不依赖外部绝对路径
const EXT_DIR = dirname(fileURLToPath(import.meta.url)); // src/
const ANALYZER_PATH = join(EXT_DIR, "..", "scripts", "analyze.py");

// 运行时数据目录使用 Pi 平台约定路径（homedir + .pi/agent/）
// 这是运行时产出数据，不是扩展自带的资源，用平台约定路径是合理的
const REPORTS_DIR = join(homedir(), ".pi", "agent", "evolution-data", "daily-reports");

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
