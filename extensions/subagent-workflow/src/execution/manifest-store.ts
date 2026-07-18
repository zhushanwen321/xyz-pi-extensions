import * as fs from "fs";
import * as path from "path";

export interface ManifestRecord {
  id: string;
  rootSessionId: string;
  agentName: string;
  status: "running" | "completed" | "failed" | "error";
  createdAt: number;
  completedAt?: number;
  sessionFile?: string;
  pid?: number;
}

export class ManifestStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Atomic write: write tmp → fsync → rename → fsync dir
   * Throws on failure (not bestEffort)
   */
  async writeManifest(record: ManifestRecord): Promise<void> {
    const filePath = path.join(this.dir, `${record.id}.json`);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    const content = JSON.stringify(record, null, 2);

    // Write tmp file
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeSync(fd, content, 0, "utf-8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    // Rename tmp → final
    fs.renameSync(tmpPath, filePath);

    // Fsync directory
    const dirFd = fs.openSync(this.dir, "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }

  /**
   * Read manifest by id. Returns null if not found.
   */
  async readManifest(id: string): Promise<ManifestRecord | null> {
    const filePath = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as ManifestRecord;
  }

  /**
   * Recover tmp files on startup.
   * 3-branch logic:
   * 1. Manifest exists → delete tmp (stale)
   * 2. Tmp valid + manifest missing → rename tmp to manifest
   * 3. Tmp invalid + manifest missing → delete tmp
   */
  async recoverTmpFiles(): Promise<{ deleted: number; recovered: number }> {
    let deleted = 0;
    let recovered = 0;

    const files = fs.readdirSync(this.dir);
    const tmpFiles = files.filter((f) => f.includes(".json.tmp."));

    for (const tmpFile of tmpFiles) {
      const tmpPath = path.join(this.dir, tmpFile);
      const manifestId = tmpFile.split(".json.tmp.")[0];
      const manifestPath = path.join(this.dir, `${manifestId}.json`);

      if (fs.existsSync(manifestPath)) {
        // Branch 1: Manifest exists, delete tmp
        fs.unlinkSync(tmpPath);
        deleted++;
      } else {
        // Try parse tmp
        try {
          const content = fs.readFileSync(tmpPath, "utf-8");
          JSON.parse(content);
          // Branch 2: Tmp valid, rename to manifest
          fs.renameSync(tmpPath, manifestPath);
          recovered++;
        } catch {
          // Branch 3: Tmp invalid, delete
          fs.unlinkSync(tmpPath);
          deleted++;
        }
      }
    }

    return { deleted, recovered };
  }
}
