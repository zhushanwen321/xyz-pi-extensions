/**
 * CwStore — JSON 文件持久化层（替代原 node:sqlite 方案）。
 *
 * 背景：pi 的 Bun 编译 binary 未实现 node:sqlite（oven-sh/bun #20412），
 * 导致 extension 加载失败 + pi exit(1)。改为 JSON 文件持久化，零外部依赖，
 * Bun runtime 完整支持 node:fs。
 *
 * 职责：
 *   - JSON 文件读写（~/.pi/agent/cw/<encoded-cwd>/_cw.json）
 *   - 内存事务：transaction 回调在深拷贝副本上操作，正常→原子落盘，异常→丢弃（ROLLBACK）
 *   - 跨进程文件锁：lockfile + O_EXCL 原子创建（替代 sqlite 的 WAL + busy_timeout）
 *   - 4 集合 DAO（topic / wave / test_case / gate_history，对应原 4 表）
 *   - schema 演进：schemaVersion 字段（替代 PRAGMA user_version）
 *
 * 事务等价性（与原 sqlite 对比）：
 *   - 原子性：内存深拷贝操作 → temp + fsync + rename 一次性落盘（POSIX rename 原子）
 *   - 隔离性：文件锁串行化 + 内存副本隔离（同事务内 read-after-write 天然一致）
 *   - 持久性：fsync(temp) + fsync(dir) 保证落盘
 *   - 崩溃一致性：任一阶段 crash，磁盘上要么旧文件完整要么新文件完整
 *
 * 接口不变式：CwStore 的全部 public 方法签名与原 sqlite 版本一致，
 * 上层（state-machine、actions、gates）零改动。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

import type {
  Actual,
  CwAction,
  CwStatus,
  CwTopic,
  Evidence,
  GateHistoryEntry,
  GateHistorySeed,
  GateTier,
  TestCase,
  TestCaseSeed,
  Tier,
  Wave,
  WaveSeed,
} from "./types.js";

// ── schema 版本（替代 PRAGMA user_version） ──────────────────

export const SCHEMA_VERSION = 4;

/**
 * 各 schema 版本的语义边界（migrate 用）。每个版本对应一次结构变更：
 *   V2: topic 加 topicDir（ROOT-01）；V3: testCase 加 requiresScreenshot（P0）；
 *   V4: testCase 加 dependsOn + parallelGroup（ADR-029 决策 4）。
 */
const SCHEMA_V = {
  topicDirAdded: 2,
  requiresScreenshotAdded: 3,
  dependsOnAdded: 4,
} as const;

/** JSON 序列化缩进（2 spaces，可读性 + 紧凑性平衡）。 */
const JSON_INDENT = 2;

// ── JSON 文件结构（4 集合，对应原 4 表） ──────────────────────

/**
 * TopicRecord — topic 集合的元素（对应原 topic 表）。
 * 字段直接用领域模型命名（camelCase），无需 snake_case 转换。
 */
interface TopicRecord {
  topicId: string;
  slug: string;
  tier: Tier;
  objective: string;
  workspacePath: string;
  topicDir: string;
  createdAt: string;
  status: CwStatus;
  planFormat?: "lite" | "mid-clarify" | "mid-detail";
  coverage?: number;
  gatePassed: Partial<Record<CwAction, boolean>>;
  evidence?: Evidence;
}

/** WaveRecord — wave 集合的元素（对应原 wave 表），含 topicId 外键。 */
interface WaveRecord {
  topicId: string;
  id: string;
  dependsOn: string[];
  parallelGroup?: string;
  committed: string | null;
  changes: string[];
  issues: string[];
}

/** TestCaseRecord — test_case 集合的元素（对应原 test_case 表），含 topicId 外键。 */
interface TestCaseRecord {
  topicId: string;
  id: string;
  layer: TestCase["layer"];
  scenario: string;
  steps: string;
  expected?: { url?: string; text?: string };
  assertion?: string;
  executor: string;
  status: TestCase["status"];
  actual?: Actual;
  screenshotPath?: string;
  commitHash?: string;
  judgedAt?: string;
  failureReason?: string;
  requiresScreenshot?: boolean;
  dependsOn?: string[];
  parallelGroup?: string;
}

/** GateHistoryRecord — gate_history 集合的元素（对应原 gate_history 表），含 topicId 外键。 */
interface GateHistoryRecord {
  id: number;
  topicId: string;
  phase: CwAction;
  action: CwAction;
  gate: string;
  tier: GateTier;
  result: "pass" | "fail";
  ts: string;
  report?: string;
  progressive: boolean;
}

/** JSON 文件顶层结构。 */
interface CwJsonFile {
  schemaVersion: number;
  topics: TopicRecord[];
  waves: WaveRecord[];
  testCases: TestCaseRecord[];
  gateHistory: GateHistoryRecord[];
}

// ── 常量 ─────────────────────────────────────────────────────

/** 文件锁退避重试上限（与原 sqlite busy_timeout=5000 对齐：100ms × 50 = 5s）。 */
const LOCK_MAX_RETRIES = 50;
const LOCK_RETRY_DELAY_MS = 100;
/** stale lock 超时阈值：事务不应超过 30s，超时视为持有者进程已死。 */
const LOCK_STALE_TIMEOUT_MS = 30_000;
/** Atomics.wait 需要的 Int32Array 字节数。 */
const INT32_BYTES = 4;

// ── CwStore ──────────────────────────────────────────────────

export class CwStore {
  private dbPath: string;
  private lockPath: string;
  /** 内存缓存（事务内持有，事务外为 null）。 */
  private fileData: CwJsonFile | null = null;
  private inTransaction = false;
  private lockHeld = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.lockPath = dbPath + ".lock";
    // 父目录自动创建（全局路径首次使用时目录可能不存在）。
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  // ── 文件 IO ────────────────────────────────────────────────

  /**
   * 从磁盘读取 JSON 文件。文件不存在或解析失败时返回空库。
   * 触发 schemaVersion 迁移（补默认值），迁移后落盘。
   */
  private loadFileData(): CwJsonFile {
    if (!existsSync(this.dbPath)) {
      return this.emptyFile();
    }
    let data: CwJsonFile;
    try {
      const raw = readFileSync(this.dbPath, "utf-8");
      data = JSON.parse(raw) as CwJsonFile;
    } catch {
      // 文件损坏（崩溃写入半个文件等极端情况）→ 回退空库。
      // 原子写入（temp+rename）正常情况下不会出现半个文件，这里是终极兜底。
      return this.emptyFile();
    }
    // schemaVersion 缺失或不是数字 → 视为 v0
    if (typeof data.schemaVersion !== "number") {
      data.schemaVersion = 0;
    }
    if (!Array.isArray(data.topics)) data.topics = [];
    if (!Array.isArray(data.waves)) data.waves = [];
    if (!Array.isArray(data.testCases)) data.testCases = [];
    if (!Array.isArray(data.gateHistory)) data.gateHistory = [];

    if (data.schemaVersion < SCHEMA_VERSION) {
      this.migrate(data);
    }
    return data;
  }

  /** 空库初始值。 */
  private emptyFile(): CwJsonFile {
    return {
      schemaVersion: SCHEMA_VERSION,
      topics: [],
      waves: [],
      testCases: [],
      gateHistory: [],
    };
  }

  /**
   * schemaVersion 迁移（替代原 PRAGMA user_version + ALTER TABLE 链）。
   * JSON 方案字段直接存在领域对象上，旧版本缺字段时补默认值。
   *
   * v0→v2: topic 补 topicDir（原 sqlite v1→v2 加 topic_dir 列）
   * v0→v3: testCase 补 requiresScreenshot（原 v2→v3）
   * v0→v4: testCase 补 dependsOn（原 v3→v4）
   */
  private migrate(data: CwJsonFile): void {
    const from = data.schemaVersion;

    // 各版本迁移边界：V2 补 topicDir、V3 补 requiresScreenshot、V4 补 dependsOn。
    // 版本号对应原 sqlite 的 PRAGMA user_version（见文件头注释）。
    if (data.schemaVersion < SCHEMA_V.topicDirAdded) {
      for (const t of data.topics) {
        if (t.topicDir === undefined) t.topicDir = "";
      }
    }
    if (data.schemaVersion < SCHEMA_V.requiresScreenshotAdded) {
      for (const tc of data.testCases) {
        if (tc.requiresScreenshot === undefined) tc.requiresScreenshot = false;
      }
    }
    if (data.schemaVersion < SCHEMA_V.dependsOnAdded) {
      for (const tc of data.testCases) {
        if (tc.dependsOn === undefined) tc.dependsOn = [];
        // parallelGroup 缺失保持 undefined（与原 sqlite NULL → undefined 一致）
      }
    }

    data.schemaVersion = SCHEMA_VERSION;
    this.logMigration(from, SCHEMA_VERSION);
  }

  /** 落结构化迁移日志（走 stderr 不污染 tool stdout）。 */
  private logMigration(from: number, to: number): void {
    const line = JSON.stringify({
      event: "cw-migration",
      from,
      to,
      ts: new Date().toISOString(),
    });
    process.stderr.write(`${line}\n`);
  }

  /**
   * 原子写入磁盘（write temp → fsync → rename → fsync dir）。
   * 任一阶段 crash，磁盘上要么旧文件完整要么新文件完整。
   */
  private flushToDisk(): void {
    const json = JSON.stringify(this.fileData, null, JSON_INDENT);
    const tmpPath = this.dbPath + ".tmp";

    // 1. 写临时文件
    writeFileSync(tmpPath, json, "utf-8");

    // 2. fsync 临时文件（确保数据到磁盘，不止 OS page cache）
    const tmpFd = openSync(tmpPath, "r");
    try {
      fsyncSync(tmpFd);
    } finally {
      closeSync(tmpFd);
    }

    // 3. rename 临时文件 → 正式文件（POSIX 原子操作）
    renameSync(tmpPath, this.dbPath);

    // 4. fsync 目录（确保 rename 的 dir entry 持久化）
    const dirFd = openSync(dirname(this.dbPath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  // ── 文件锁（跨进程排他） ───────────────────────────────────

  /**
   * 获取排他锁。lockfile + O_EXCL 原子创建，退避重试直到获锁或超时。
   * stale lock 检测：持有者进程已死或超过 30s → 强制 break。
   */
  private acquireLock(): void {
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      try {
        // O_EXCL ('wx'): 原子创建，已存在则抛 EEXIST
        const fd = openSync(this.lockPath, "wx");
        try {
          writeSync(fd, `${process.pid}\n${Date.now()}\n`);
        } finally {
          closeSync(fd);
        }
        this.lockHeld = true;
        return;
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === "EEXIST") {
          // 锁文件已存在：检测 stale lock
          if (this.isStaleLock()) {
            this.breakStaleLock();
            continue; // 重试创建
          }
          // 活锁：退避等待
          this.sleep(LOCK_RETRY_DELAY_MS);
          continue;
        }
        // 其他错误（权限/磁盘满等）
        throw e;
      }
    }
    throw new Error(
      `CwStore: failed to acquire lock after ${LOCK_MAX_RETRIES} retries (${this.lockPath})`,
    );
  }

  /** 释放锁。 */
  private releaseLock(): void {
    if (!this.lockHeld) return;
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      // best-effort：锁文件可能已被 stale lock 机制清理（并发持有者 break）
      void e;
    }
    this.lockHeld = false;
  }

  /** 检测锁文件是否 stale（持有者进程已死 或 超过 30s）。 */
  private isStaleLock(): boolean {
    try {
      const content = readFileSync(this.lockPath, "utf-8").trim().split("\n");
      const pid = Number(content[0]);
      const ts = Number(content[1]);

      // 超时判定（保险：事务不应超过 30s）
      if (Number.isFinite(ts) && Date.now() - ts > LOCK_STALE_TIMEOUT_MS) {
        return true;
      }

      // 进程探活（signal 0 = 不发信号，只检测进程是否存在）
      if (Number.isFinite(pid) && pid > 0) {
        return !this.isProcessAlive(pid);
      }
      return true; // PID 无效 → stale
    } catch {
      return true; // 读不到也当 stale
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private breakStaleLock(): void {
    try {
      unlinkSync(this.lockPath);
    } catch (e) {
      // best-effort：锁文件已被释放或并发 break
      void e;
    }
  }

  /** 同步退避等待（Atomics.wait 在主线程也有效，阻塞当前执行流）。 */
  private sleep(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(INT32_BYTES)), 0, 0, ms);
  }

  // ── 事务 ───────────────────────────────────────────────────

  /**
   * 事务包裹：fn 在内存深拷贝副本上操作，正常→原子落盘，异常→丢弃副本（ROLLBACK）。
   *
   * 等价原 sqlite 事务语义：
   *   - 原子性：structuredClone 隔离 + flushToDisk 原子写入
   *   - read-after-write：内存副本天然一致
   *   - 并发串行化：acquireLock 排他
   */
  transaction<T>(fn: () => T): T {
    // 重入保护：已在事务内时直接复用内存副本（避免死锁——自己等自己的锁）。
    // executeWrite 的「事务外隐式事务」路径不会走到这里（它先检查 inTransaction），
    // 但显式 transaction() 的嵌套调用会走到。action handler 当前不嵌套，此处是防御。
    if (this.inTransaction && this.fileData) {
      return fn();
    }

    this.acquireLock();
    const snapshot = this.loadFileData();
    this.fileData = structuredClone(snapshot);
    this.inTransaction = true;

    try {
      const result = fn();
      this.flushToDisk();
      return result;
    } catch (err) {
      // ROLLBACK：丢弃内存副本，恢复为磁盘状态
      this.fileData = snapshot;
      throw err;
    } finally {
      this.inTransaction = false;
      this.fileData = null;
      this.releaseLock();
    }
  }

  /**
   * 获取当前活跃数据。
   * - 事务内：返回 this.fileData（内存副本，read-after-write 一致）
   * - 事务外：读磁盘
   */
  private getActiveData(): CwJsonFile {
    if (this.inTransaction && this.fileData) {
      return this.fileData;
    }
    return this.loadFileData();
  }

  /**
   * 写方法的包装器：确保在事务上下文中执行写操作。
   *
   * - 事务内（显式 transaction）：直接执行 fn（复用内存副本，read-after-write 一致）
   * - 事务外：自动开启隐式单次事务（加载磁盘 → 执行 fn → 原子落盘），
   *   兼容原 sqlite 版本的「写方法可独立调用」模式（测试种子数据等场景）。
   *
   * 隐式事务的性能开销：每次写都读全量 JSON + 落盘。action handler 仍应用
   * 显式 transaction() 批量写以避免多次 IO。
   */
  private executeWrite(fn: () => void): void {
    if (this.inTransaction && this.fileData) {
      fn();
      return;
    }
    this.transaction(fn);
  }

  // ── topic DAO ──────────────────────────────────────────────

  insertTopic(topic: CwTopic): void {
    this.executeWrite(() => {
      // 唯一性约束（对应原 sqlite PRIMARY KEY）：topicId 重复时抛错
      const exists = this.fileData!.topics.some(
        (t) => t.topicId === topic.topicId,
      );
      if (exists) {
        throw new Error(
          `UNIQUE constraint failed: topic.topicId '${topic.topicId}'`,
        );
      }
      const record: TopicRecord = {
        topicId: topic.topicId,
        slug: topic.slug,
        tier: topic.tier,
        objective: topic.objective,
        workspacePath: topic.workspacePath,
        topicDir: topic.topicDir,
        createdAt: topic.createdAt,
        status: topic.status,
        planFormat: topic.planFormat,
        coverage: topic.coverage,
        gatePassed: topic.gatePassed,
        evidence: topic.evidence,
      };
      this.fileData!.topics.push(record);
    });
  }

  loadTopic(topicId: string): CwTopic | null {
    const data = this.getActiveData();
    const record = data.topics.find((t) => t.topicId === topicId);
    if (!record) return null;
    const waves = data.waves.filter((w) => w.topicId === topicId);
    const testCases = data.testCases.filter((tc) => tc.topicId === topicId);
    const gateHistory = data.gateHistory
      .filter((g) => g.topicId === topicId)
      .sort((a, b) => a.id - b.id);
    return this.assembleTopic(record, waves, testCases, gateHistory);
  }

  /** Record → CwTopic 拼装（对应原 assembleTopic）。 */
  private assembleTopic(
    topic: TopicRecord,
    waves: WaveRecord[],
    testCases: TestCaseRecord[],
    gateHistory: GateHistoryRecord[],
  ): CwTopic {
    return {
      schemaVersion: SCHEMA_VERSION,
      topicId: topic.topicId,
      slug: topic.slug,
      tier: topic.tier,
      objective: topic.objective,
      workspacePath: topic.workspacePath,
      topicDir: topic.topicDir ?? "",
      createdAt: topic.createdAt,
      status: topic.status,
      planFormat: topic.planFormat,
      waves: waves.map((w) => this.mapWaveRecord(w)),
      testCases: testCases.map((tc) => this.mapTestCaseRecord(tc)),
      gateHistory: gateHistory.map((g) => this.mapGateHistoryRecord(g)),
      gatePassed: topic.gatePassed ?? {},
      evidence: topic.evidence,
      coverage: topic.coverage,
    };
  }

  private mapWaveRecord(r: WaveRecord): Wave {
    return {
      id: r.id,
      dependsOn: r.dependsOn ?? [],
      parallelGroup: r.parallelGroup,
      committed: r.committed ?? null,
      changes: r.changes ?? [],
      issues: r.issues ?? [],
    };
  }

  private mapTestCaseRecord(r: TestCaseRecord): TestCase {
    return {
      id: r.id,
      layer: r.layer,
      scenario: r.scenario,
      steps: r.steps,
      expected: r.expected,
      assertion: r.assertion,
      executor: r.executor,
      status: r.status,
      actual: r.actual,
      screenshotPath: r.screenshotPath,
      commitHash: r.commitHash,
      judgedAt: r.judgedAt,
      failureReason: r.failureReason,
      requiresScreenshot: r.requiresScreenshot === true,
      dependsOn: r.dependsOn ?? [],
      parallelGroup: r.parallelGroup,
    };
  }

  private mapGateHistoryRecord(r: GateHistoryRecord): GateHistoryEntry {
    return {
      id: r.id,
      phase: r.phase,
      action: r.action,
      gate: r.gate,
      tier: r.tier,
      result: r.result,
      ts: r.ts,
      report: r.report,
      progressive: r.progressive,
    };
  }

  updateStatus(topicId: string, status: CwStatus): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) topic.status = status;
    });
  }

  updateGatePassed(topicId: string, phase: CwAction, passed: boolean): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) {
        topic.gatePassed = { ...topic.gatePassed, [phase]: passed };
      }
    });
  }

  setEvidence(topicId: string, evidence: Evidence): void {
    this.executeWrite(() => {
      const topic = this.fileData!.topics.find((t) => t.topicId === topicId);
      if (topic) {
        topic.coverage = evidence.coverage;
        topic.evidence = evidence;
      }
    });
  }

  // ── wave DAO ───────────────────────────────────────────────

  insertWaves(topicId: string, waves: WaveSeed[]): void {
    this.executeWrite(() => {
      for (const w of waves) {
        const record: WaveRecord = {
          topicId,
          id: w.id,
          dependsOn: w.dependsOn,
          parallelGroup: w.parallelGroup,
          committed: null,
          changes: w.changes,
          issues: w.issues,
        };
        this.fileData!.waves.push(record);
      }
    });
  }

  setWaveCommitted(topicId: string, waveId: string, commitHash: string): void {
    this.executeWrite(() => {
      const wave = this.fileData!.waves.find(
        (w) => w.topicId === topicId && w.id === waveId,
      );
      if (wave) wave.committed = commitHash;
    });
  }

  // ── test_case DAO ──────────────────────────────────────────

  insertTestCases(topicId: string, cases: TestCaseSeed[]): void {
    this.executeWrite(() => {
      for (const c of cases) {
        const record: TestCaseRecord = {
          topicId,
          id: c.id,
          layer: c.layer,
          scenario: c.scenario,
          steps: c.steps,
          expected: c.expected,
          assertion: c.assertion,
          executor: c.executor,
          status: "pending", // insertTestCases 默认 pending（与原 sqlite 一致）
          requiresScreenshot: c.requiresScreenshot === true,
          dependsOn: c.dependsOn,
          parallelGroup: c.parallelGroup,
        };
        this.fileData!.testCases.push(record);
      }
    });
  }

  /** updateTestCase 允许 patch 的字段白名单（对应原 TEST_CASE_PATCH_COLUMNS）。 */
  updateTestCase(topicId: string, caseId: string, patch: Partial<TestCase>): void {
    this.executeWrite(() => {
      const tc = this.fileData!.testCases.find(
        (c) => c.topicId === topicId && c.id === caseId,
      );
      if (!tc) return;

      if ("status" in patch) tc.status = patch.status as TestCase["status"];
      if ("actual" in patch) tc.actual = patch.actual;
      if ("screenshotPath" in patch) tc.screenshotPath = patch.screenshotPath;
      if ("commitHash" in patch) tc.commitHash = patch.commitHash;
      if ("judgedAt" in patch) tc.judgedAt = patch.judgedAt;
      if ("failureReason" in patch) tc.failureReason = patch.failureReason;
    });
  }

  // ── replan DAO（append-only replan） ───────────────────────

  /** 保留已 committed 的 wave，删除未 committed 的 + INSERT 新 plan.json 的未 committed wave。 */
  replaceUncommittedWaves(topicId: string, waves: WaveSeed[]): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      // 删除未 committed
      data.waves = data.waves.filter(
        (w) => w.topicId !== topicId || w.committed !== null,
      );
      // 插入新的（内层 executeWrite 检测到 inTransaction 直接执行）
      for (const w of waves) {
        data.waves.push({
          topicId,
          id: w.id,
          dependsOn: w.dependsOn,
          parallelGroup: w.parallelGroup,
          committed: null,
          changes: w.changes,
          issues: w.issues,
        });
      }
    });
  }

  /** 保留已 passed 的 testCase，删除非 passed 的 + INSERT 新 plan.json 的非 passed case。 */
  replaceUnpassedTestCases(topicId: string, cases: TestCaseSeed[]): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      // 删除非 passed
      data.testCases = data.testCases.filter(
        (tc) => tc.topicId !== topicId || tc.status === "passed",
      );
      // 插入新的
      for (const c of cases) {
        data.testCases.push({
          topicId,
          id: c.id,
          layer: c.layer,
          scenario: c.scenario,
          steps: c.steps,
          expected: c.expected,
          assertion: c.assertion,
          executor: c.executor,
          status: "pending",
          requiresScreenshot: c.requiresScreenshot === true,
          dependsOn: c.dependsOn,
          parallelGroup: c.parallelGroup,
        });
      }
    });
  }

  // ── gate_history DAO ───────────────────────────────────────

  appendGateHistory(topicId: string, entry: GateHistorySeed): void {
    this.executeWrite(() => {
      const data = this.fileData!;
      // id 自增（对应原 sqlite AUTOINCREMENT）
      const maxId = data.gateHistory.reduce((max, g) => Math.max(max, g.id), 0);
      const record: GateHistoryRecord = {
        id: maxId + 1,
        topicId,
        phase: entry.phase,
        action: entry.action,
        gate: entry.gate,
        tier: entry.tier,
        result: entry.result,
        ts: new Date().toISOString(),
        report: entry.report,
        progressive: entry.progressive,
      };
      data.gateHistory.push(record);
    });
  }

  loadGateHistory(topicId: string): GateHistoryEntry[] {
    const data = this.getActiveData();
    return data.gateHistory
      .filter((g) => g.topicId === topicId)
      .sort((a, b) => a.id - b.id)
      .map((g) => this.mapGateHistoryRecord(g));
  }

  // ── lifecycle ──────────────────────────────────────────────

  close(): void {
    // JSON 方案无持久连接（不像 sqlite 的 DatabaseSync 句柄）。
    // 留空保持接口兼容——上层 index.ts 的 finally { deps.store.close() } 不需改。
    // 若有未释放的锁（异常路径），兜底释放。
    if (this.lockHeld) {
      this.releaseLock();
    }
  }
}
