import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";

import { bestEffort } from "./best-effort.ts";

export interface ManifestRecord {
  id: string;
  rootSessionId: string;
  agentName: string;
  /**
   * 终态枚举：finalizeRecord 写 running/completed/failed/cancelled 四态；cancelled 不再
   * 归并 failed。crashed 不进 manifest——crashed 是重启重建时靠 sidecar 四分支推断的派生态
   * （见 record-store.ts reconstructAll），持久化会与 sidecar source of truth 形成双源；
   * manifest 职责保持纯粹，只记录 finalize 明确产出的终态。
   * 历史 "error" 值已移除——读侧 isValidManifest 守卫拒绝，mapManifestStatus 越界返回 null。
   */
  status: "running" | "completed" | "failed" | "cancelled";
  createdAt: number;
  completedAt?: number;
  sessionFile?: string;
  /** FR-7 补字段：manifest 写入时从 ExecutionRecord 抓取，供 manifestToSubagent 投影真实值。 */
  task?: string;
  slug?: string;
  model?: string;
}

/** 合法 manifest status 集合（4 态；运行时守卫用，磁盘文件可能陈旧/损坏）。crashed 不在其中。 */
const VALID_MANIFEST_STATUSES: ReadonlySet<string> = new Set([
  "running",
  "completed",
  "failed",
  "cancelled",
]);

/**
 * 校验 JSON.parse 产物是否为合法 ManifestRecord。
 * 关键字段类型检查——不合法返回 false，调用方据此过滤（防损坏/陈旧文件污染投影）。
 */
function isValidManifest(value: unknown): value is ManifestRecord {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" &&
    typeof v.rootSessionId === "string" &&
    typeof v.agentName === "string" &&
    typeof v.createdAt === "number" &&
    typeof v.status === "string" &&
    VALID_MANIFEST_STATUSES.has(v.status)
  );
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
   * 原子写：tmp → fsync → rename → fsync dir。真异步（fs.promises，不阻塞 event loop）。
   *
   * rename 失败时 best-effort 清理残留 tmp（用 renamed 标志在 catch 中决定是否 unlink），
   * 不掩盖原错误。失败向上抛——调用方（finalizeRecord）决定降级策略。
   */
  async writeManifest(record: ManifestRecord): Promise<void> {
    const filePath = path.join(this.dir, `${record.id}.json`);
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    const content = JSON.stringify(record, null, 2);

    let renamed = false;
    try {
      // 1. 写 tmp → fsync 文件
      const fh = await fsPromises.open(tmpPath, "w");
      try {
        await fh.writeFile(content, "utf-8");
        await fh.sync();
      } finally {
        await fh.close();
      }

      // 2. rename tmp → final（放入 try：失败时 catch 清理 tmp）
      await fsPromises.rename(tmpPath, filePath);
      renamed = true;

      // 3. fsync 目录（best-effort：POSIX 不要求，失败不否定已成功的 rename）
      try {
        const dirFh = await fsPromises.open(this.dir, "r");
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch (dirSyncErr) {
        bestEffort(dirSyncErr, "fsync dir (writeManifest)");
      }
    } catch (err) {
      // rename 未成功 → 清理残留 tmp（best-effort，不掩盖原错误）
      if (!renamed) {
        try {
          await fsPromises.unlink(tmpPath);
        } catch (cleanupErr) {
          // best-effort：tmp 可能已被 rename 消费或从未创建。不影响主错误（下面 re-throw err）
          bestEffort(cleanupErr, "unlink tmp (writeManifest)");
        }
      }
      throw err;
    }
  }

  /**
   * 按 id 读 manifest。文件不存在/JSON 损坏/schema 不合法均返回 null。
   * 调用方需处理 null。
   */
  async readManifest(id: string): Promise<ManifestRecord | null> {
    const filePath = path.join(this.dir, `${id}.json`);
    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      return isValidManifest(parsed) ? parsed : null;
    } catch {
      // 文件缺失（ENOENT）或 JSON 损坏（SyntaxError）均降级为 null
      return null;
    }
  }

  /**
   * 同步读取所有 manifest 记录（best-effort，损坏/非法文件跳过）。
   * 供 RecordStore.collectRecords 投影 orphan 记录使用——替代对私有 dir 的反射访问。
   * 仅返回通过 isValidManifest 校验的记录。
   */
  listAllSync(): readonly ManifestRecord[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const results: ManifestRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json") || file.includes(".tmp.")) continue;
      try {
        const content = fs.readFileSync(path.join(this.dir, file), "utf-8");
        const parsed: unknown = JSON.parse(content);
        if (isValidManifest(parsed)) {
          results.push(parsed);
        }
      } catch (fileErr) {
        // best-effort：损坏/非法文件跳过（debug 记录便于排查）
        bestEffort(fileErr, `read manifest ${file} (listAllSync)`);
      }
    }
    return results;
  }

  /**
   * 启动时恢复 tmp 文件。
   * 3 分支逻辑：
   * 1. manifest 已存在 → 删 tmp（陈旧）
   * 2. tmp 合法 + manifest 缺失 → rename tmp 为 manifest
   * 3. tmp 非法 + manifest 缺失 → 删 tmp
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
        // 分支 1: manifest 已存在，删 tmp
        fs.unlinkSync(tmpPath);
        deleted++;
      } else {
        // 试解析 tmp
        try {
          const content = fs.readFileSync(tmpPath, "utf-8");
          const parsed: unknown = JSON.parse(content);
          if (isValidManifest(parsed)) {
            // 分支 2: tmp 是合法 manifest，rename 为正式文件
            fs.renameSync(tmpPath, manifestPath);
            recovered++;
          } else {
            // 分支 3b: 合法 JSON 但非合法 manifest（缺必填字段），删
            fs.unlinkSync(tmpPath);
            deleted++;
          }
        } catch {
          // 分支 3a: JSON.parse 失败，删
          fs.unlinkSync(tmpPath);
          deleted++;
        }
      }
    }

    return { deleted, recovered };
  }
}
