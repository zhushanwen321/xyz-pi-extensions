/**
 * CwStore — _cw.db 持久化层（D-016 node:sqlite + 关系表模式，#1 方案 A 手写 DAO）。
 *
 * 职责：
 *   - 封装 DatabaseSync 连接（D-016）
 *   - 事务（BEGIN/COMMIT/ROLLBACK）——sqlite 天生原子，渐进式提交每次 action 一个事务
 *   - 4 表 DAO（topic / wave / test_case / gate_history，§8.1 schema）
 *   - schema 演进：PRAGMA user_version（#11）
 *
 * 应用层操作逻辑模型 CwTopic（types.ts），DAO 负责 sqlite 行 ↔ CwTopic 转换。
 * 事务边界由 service 层（action handler）控制：每个 action 一个 transaction 包裹。
 *
 * 可测性（AC-1.5）：DatabaseSync 可注入 mock，DAO 是纯数据访问。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";

import type {
  Actual,
  CwAction,
  CwStatus,
  CwTopic,
  Evidence,
  Expected,
  GateHistoryEntry,
  GateHistorySeed,
  GateTier,
  TestCase,
  TestCaseSeed,
  Tier,
  Wave,
  WaveSeed,
} from "./types.js";

// ── schema 版本（PRAGMA user_version，#11） ──────────────────

export const SCHEMA_VERSION = 3;

// ── DDL（§8.1 architecture） ────────────────────────────────

/**
 * user_version 迁移函数链（#11）。MIGRATIONS[i] 把 user_version 从 i 升到 i+1。
 * v0→v1 由 DDL（CREATE TABLE IF NOT EXISTS）完成，无显式迁移函数。
 * v1→v2 给 topic 表加 topic_dir 列（ROOT-01 修复：CW 需要记录每个 topic 的交付物目录）。
 * v2→v3 给 test_case 表加 requires_screenshot 列（P0：plan 阶段声明每条用例是否要求截图，
 * 避免 test.ts 无差别要求所有 lite case 都传 screenshotPath）。
 * 未来 schema 演进（如 full 接入）在此追加 ALTER TABLE 函数。
 */
const MIGRATIONS: Array<(db: DatabaseSync) => void> = [
  // v0 → v1: 无（初始 schema 由 DDL 建立）
  // v1 → v2: topic 表加 topic_dir 列（兼容旧库，NULL 允许，handler 用 resolveTopicDir fallback）
  // 幂等保护：PRAGMA table_info 检测列已存在则跳过（防新库 DDL 已含列时重复 ALTER）
  (db: DatabaseSync) => {
    const cols = db.prepare("PRAGMA table_info(topic)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "topic_dir")) {
      db.exec("ALTER TABLE topic ADD COLUMN topic_dir TEXT");
    }
  },
  // v2 → v3: test_case 表加 requires_screenshot 列（兼容旧库，NULL 视为 false）
  // 幂等保护：检测列已存在则跳过
  (db: DatabaseSync) => {
    const cols = db.prepare("PRAGMA table_info(test_case)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "requires_screenshot")) {
      db.exec("ALTER TABLE test_case ADD COLUMN requires_screenshot INTEGER DEFAULT 0");
    }
  },
];

/**
 * 安全解析 sqlite TEXT 列里的 JSON。非字符串/空串/解析失败 → 返回 fallback。
 * 数据由本 store 写入（数据完整性自控），仅做防御性 parse。
 */
function parseJsonField<T>(raw: SQLOutputValue | undefined, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** updateTestCase 允许 patch 的字段→列名白名单（防 SQL 注入：列名不来自用户输入，T2.11）。 */
type TestCasePatchField =
  | "status"
  | "actual"
  | "screenshotPath"
  | "commitHash"
  | "judgedAt"
  | "failureReason";

const TEST_CASE_PATCH_COLUMNS: ReadonlyArray<[TestCasePatchField, string]> = [
  ["status", "status"],
  ["actual", "actual"],
  ["screenshotPath", "screenshot_path"],
  ["commitHash", "commit_hash"],
  ["judgedAt", "judged_at"],
  ["failureReason", "failure_reason"],
];

/** 把 patch 字段值编码为 sqlite 可绑定的字面值（对象→JSON 串，null/undefined→null）。 */
function encodeTestCaseValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return JSON.stringify(value);
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS topic (
    topic_id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    tier TEXT NOT NULL,
    objective TEXT NOT NULL,
    workspace_path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    plan_format TEXT,
    coverage INTEGER,
    gate_passed TEXT,
    evidence TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS wave (
    topic_id TEXT NOT NULL,
    id TEXT NOT NULL,
    depends_on TEXT,
    parallel_group TEXT,
    committed TEXT,
    changes TEXT,
    issues TEXT,
    PRIMARY KEY (topic_id, id),
    FOREIGN KEY (topic_id) REFERENCES topic(topic_id)
  )`,
  `CREATE TABLE IF NOT EXISTS test_case (
    topic_id TEXT NOT NULL,
    id TEXT NOT NULL,
    layer TEXT NOT NULL,
    scenario TEXT NOT NULL,
    steps TEXT NOT NULL,
    expected TEXT,
    assertion TEXT,
    executor TEXT NOT NULL,
    status TEXT NOT NULL,
    actual TEXT,
    screenshot_path TEXT,
    commit_hash TEXT,
    judged_at TEXT,
    failure_reason TEXT,
    requires_screenshot INTEGER DEFAULT 0,
    PRIMARY KEY (topic_id, id),
    FOREIGN KEY (topic_id) REFERENCES topic(topic_id)
  )`,
  `CREATE TABLE IF NOT EXISTS gate_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    action TEXT NOT NULL,
    gate TEXT NOT NULL,
    tier TEXT NOT NULL,
    result TEXT NOT NULL,
    ts TEXT NOT NULL,
    report TEXT,
    progressive INTEGER,
    FOREIGN KEY (topic_id) REFERENCES topic(topic_id)
  )`,
];

export class CwStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    // SDK 契约：node:sqlite DatabaseSync 构造打开连接（D-016 实测：ESM import + 文件持久化 OK）。
    // 父目录自动创建：全局路径（~/.pi/agent/cw/<encoded-cwd>/）首次使用时目录可能不存在，
    // sqlite 不会自动建父目录。项目内路径（旧版 .xyz-harness/）也兼容——mkdirSync 已存在不报错。
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    // ADR-029 决策 6：WAL 模式 + busy_timeout，支持 workflow 内多 agent 并发调 cw。
    // WAL：并发读不阻塞写，写不阻塞读（单写串行排队）。
    // busy_timeout=5000：撞写锁时等待 5s 重试而非立即报 SQLITE_BUSY（覆盖短事务场景）。
    // 必须在任何业务 SQL 之前执行（init 的 DDL 也受 WAL 并发保护）。
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.init();
  }

  private init(): void {
    // 接线：建表 + user_version 迁移链（#11，未来 ALTER TABLE 链）。
    // DDL 保持 v1 初始结构，topic_dir 等新增列由迁移链加（ALTER ADD COLUMN）。
    // 这样全新库与旧库都走迁移链，路径统一，避免“DDL 建列 + 迁移加列”冲突。
    for (const stmt of DDL) {
      this.db.exec(stmt);
    }
    const current = this.readUserVersion();
    if (current < SCHEMA_VERSION) {
      this.runMigrations(current, SCHEMA_VERSION);
    }
  }

  /** 读 PRAGMA user_version（缺省 0）。 */
  private readUserVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get();
    const v = row?.user_version;
    return typeof v === "number" ? v : 0;
  }

  /**
   * 按 user_version 顺序跑迁移函数链（#11）。
   * MIGRATIONS[i] 把 user_version 从 i 升到 i+1。当前 SCHEMA_VERSION=1 链为空
   * （v1 初始 schema 由 DDL 建），结构为未来 ALTER TABLE 留扩展点。
   */
  private runMigrations(from: number, to: number): void {
    for (let v = from; v < to; v++) {
      const migrate = MIGRATIONS[v];
      if (migrate) migrate(this.db);
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    this.logMigration(from, to);
  }

  /** 落结构化迁移日志（from→to，T2.28）。走 stderr 不污染 tool stdout。 */
  private logMigration(from: number, to: number): void {
    const line = JSON.stringify({
      event: "cw-migration",
      from,
      to,
      ts: new Date().toISOString(),
    });
    process.stderr.write(`${line}\n`);
  }

  // ── 事务（#1 AC-1.2 原子性） ────────────────────────────────

  /**
   * 事务包裹：fn 抛错 → ROLLBACK 重抛；正常 → COMMIT。
   * sqlite 天生原子（D-016 实测：崩溃事务不污染）。
   */
  transaction<T>(fn: () => T): T {
    // 接线：BEGIN → fn() → COMMIT，catch → ROLLBACK 重抛。
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ── topic DAO ──────────────────────────────────────────────

  insertTopic(topic: CwTopic): void {
    // 接线：prepare + run，参数绑定。
    const stmt = this.db.prepare(
      `INSERT INTO topic (topic_id, slug, tier, objective, workspace_path, topic_dir, created_at, status, plan_format, coverage, gate_passed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      topic.topicId,
      topic.slug,
      topic.tier,
      topic.objective,
      topic.workspacePath,
      topic.topicDir,
      topic.createdAt,
      topic.status,
      topic.planFormat ?? null,
      topic.coverage ?? null,
      JSON.stringify(topic.gatePassed),
    );
  }

  loadTopic(topicId: string): CwTopic | null {
    // 接线：4 表分查 → assembleTopic 拼装逻辑模型。
    const topicRow = this.selectTopicRow(topicId);
    if (!topicRow) {
      return null;
    }
    const waveRows = this.selectWaveRows(topicId);
    const testCaseRows = this.selectTestCaseRows(topicId);
    const gateHistoryRows = this.selectGateHistoryRows(topicId);
    return this.assembleTopic(topicRow, waveRows, testCaseRows, gateHistoryRows);
  }

  private selectTopicRow(topicId: string): unknown {
    return this.db.prepare(`SELECT * FROM topic WHERE topic_id = ?`).get(topicId);
  }

  private selectWaveRows(topicId: string): unknown[] {
    return this.db.prepare(`SELECT * FROM wave WHERE topic_id = ?`).all(topicId);
  }

  private selectTestCaseRows(topicId: string): unknown[] {
    return this.db.prepare(`SELECT * FROM test_case WHERE topic_id = ?`).all(topicId);
  }

  private selectGateHistoryRows(topicId: string): unknown[] {
    return this.db.prepare(`SELECT * FROM gate_history WHERE topic_id = ? ORDER BY id ASC`).all(topicId);
  }

  /** 行 → CwTopic 拼装（4 表 select 结果组装逻辑模型）。 */
  private assembleTopic(
    topicRow: unknown,
    waveRows: unknown[],
    testCaseRows: unknown[],
    gateHistoryRows: unknown[],
  ): CwTopic {
    const tr = topicRow as Record<string, SQLOutputValue>;
    const waves = (waveRows as Record<string, SQLOutputValue>[]).map((r) => this.mapWaveRow(r));
    const testCases = (testCaseRows as Record<string, SQLOutputValue>[]).map((r) =>
      this.mapTestCaseRow(r),
    );
    const gateHistory = (gateHistoryRows as Record<string, SQLOutputValue>[]).map((r) =>
      this.mapGateHistoryRow(r),
    );
    return {
      schemaVersion: SCHEMA_VERSION,
      topicId: String(tr.topic_id),
      slug: String(tr.slug),
      tier: String(tr.tier) as Tier,
      objective: String(tr.objective),
      workspacePath: String(tr.workspace_path),
      topicDir:
        tr.topic_dir === null || tr.topic_dir === undefined
          ? ""
          : String(tr.topic_dir),
      createdAt: String(tr.created_at),
      status: String(tr.status) as CwStatus,
      planFormat:
        tr.plan_format === null ? undefined : (String(tr.plan_format) as CwTopic["planFormat"]),
      waves,
      testCases,
      gateHistory,
      gatePassed: parseJsonField<Partial<Record<CwAction, boolean>>>(tr.gate_passed, {}),
      coverage: typeof tr.coverage === "number" ? tr.coverage : undefined,
      evidence: parseJsonField<Evidence | undefined>(tr.evidence, undefined),
    };
  }

  private mapWaveRow(r: Record<string, SQLOutputValue>): Wave {
    return {
      id: String(r.id),
      dependsOn: parseJsonField<string[]>(r.depends_on, []),
      parallelGroup: r.parallel_group === null ? undefined : String(r.parallel_group),
      committed: r.committed === null ? null : String(r.committed),
      changes: parseJsonField<string[]>(r.changes, []),
      issues: parseJsonField<string[]>(r.issues, []),
    };
  }

  private mapTestCaseRow(r: Record<string, SQLOutputValue>): TestCase {
    return {
      id: String(r.id),
      layer: String(r.layer) as TestCase["layer"],
      scenario: String(r.scenario),
      steps: String(r.steps),
      expected: parseJsonField<Expected | undefined>(r.expected, undefined),
      assertion: r.assertion === null ? undefined : String(r.assertion),
      executor: String(r.executor),
      status: String(r.status) as TestCase["status"],
      actual: parseJsonField<Actual | undefined>(r.actual, undefined),
      screenshotPath: r.screenshot_path === null ? undefined : String(r.screenshot_path),
      commitHash: r.commit_hash === null ? undefined : String(r.commit_hash),
      judgedAt: r.judged_at === null ? undefined : String(r.judged_at),
      failureReason: r.failure_reason === null ? undefined : String(r.failure_reason),
      // v3 列：旧库迁移后 NULL/0 → false；新库写入时布尔转 0/1
      requiresScreenshot: r.requires_screenshot === 1,
    };
  }

  private mapGateHistoryRow(r: Record<string, SQLOutputValue>): GateHistoryEntry {
    return {
      id: typeof r.id === "number" ? r.id : Number(r.id),
      phase: String(r.phase) as CwAction,
      action: String(r.action) as CwAction,
      gate: String(r.gate),
      tier: String(r.tier) as GateTier,
      result: String(r.result) as "pass" | "fail",
      ts: String(r.ts),
      report: r.report === null ? undefined : String(r.report),
      progressive: r.progressive === 1,
    };
  }

  updateStatus(topicId: string, status: CwStatus): void {
    // 接线：prepare + run。
    this.db.prepare(`UPDATE topic SET status = ? WHERE topic_id = ?`).run(status, topicId);
  }

  updateGatePassed(topicId: string, phase: CwAction, passed: boolean): void {
    // 数据流：gate_passed 是 topic 表 JSON 列。读现值 → 改一 phase → JSON.stringify 写回。
    const row = this.db.prepare(`SELECT gate_passed FROM topic WHERE topic_id = ?`).get(topicId);
    const current = parseJsonField<Partial<Record<CwAction, boolean>>>(row?.gate_passed, {});
    current[phase] = passed;
    this.db.prepare(`UPDATE topic SET gate_passed = ? WHERE topic_id = ?`).run(
      JSON.stringify(current),
      topicId,
    );
  }

  setEvidence(topicId: string, evidence: Evidence): void {
    // 接线：closeout 终态填充——evidence 整体序列化到 topic.evidence 列（closedAt/coverage/gateHistory 快照）。
    // coverage 同时写独立列，便于按覆盖率直查（evidence JSON 是完整快照，coverage 列是冗余索引）。
    this.db
      .prepare(`UPDATE topic SET coverage = ?, evidence = ? WHERE topic_id = ?`)
      .run(evidence.coverage ?? null, JSON.stringify(evidence), topicId);
  }

  // ── wave DAO ───────────────────────────────────────────────

  insertWaves(topicId: string, waves: WaveSeed[]): void {
    // 接线：loop + prepare + run（D-005 渐进式，plan/detail 解析后批量写）。
    const stmt = this.db.prepare(
      `INSERT INTO wave (topic_id, id, depends_on, parallel_group, committed, changes, issues)
       VALUES (?, ?, ?, ?, NULL, ?, ?)`,
    );
    for (const w of waves) {
      stmt.run(
        topicId,
        w.id,
        JSON.stringify(w.dependsOn),
        w.parallelGroup ?? null,
        JSON.stringify(w.changes),
        JSON.stringify(w.issues),
      );
    }
  }

  setWaveCommitted(topicId: string, waveId: string, commitHash: string): void {
    // 接线：dev action 逐条，GitValidator 通过后写 committed。
    this.db.prepare(`UPDATE wave SET committed = ? WHERE topic_id = ? AND id = ?`).run(
      commitHash,
      topicId,
      waveId,
    );
  }

  // ── test_case DAO ──────────────────────────────────────────

  insertTestCases(topicId: string, cases: TestCaseSeed[]): void {
    // 接线：loop + prepare + run。
    const stmt = this.db.prepare(
      `INSERT INTO test_case (topic_id, id, layer, scenario, steps, expected, assertion, executor, status, requires_screenshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    );
    for (const c of cases) {
      stmt.run(
        topicId,
        c.id,
        c.layer,
        c.scenario,
        c.steps,
        c.expected ? JSON.stringify(c.expected) : null,
        c.assertion ?? null,
        c.executor,
        c.requiresScreenshot ? 1 : 0,
      );
    }
  }

  updateTestCase(topicId: string, caseId: string, patch: Partial<TestCase>): void {
    // 动态拼 SET 子句：按 patch 键查列名白名单，全参数绑定（防 SQL 注入，T2.11）。
    const sets: string[] = [];
    const binds: SQLInputValue[] = [];
    for (const [field, col] of TEST_CASE_PATCH_COLUMNS) {
      if (field in patch) {
        sets.push(`${col} = ?`);
        binds.push(encodeTestCaseValue(patch[field]));
      }
    }
    if (sets.length === 0) return; // 无可更新字段，no-op
    binds.push(topicId, caseId);
    this.db
      .prepare(`UPDATE test_case SET ${sets.join(", ")} WHERE topic_id = ? AND id = ?`)
      .run(...binds);
  }

  // ── gate_history DAO ───────────────────────────────────────

  appendGateHistory(topicId: string, entry: GateHistorySeed): void {
    // 接线：每次 action finally 追加（§5.3；#4 AC-4.3）。
    this.db.prepare(
      `INSERT INTO gate_history (topic_id, phase, action, gate, tier, result, ts, report, progressive)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      topicId,
      entry.phase,
      entry.action,
      entry.gate,
      entry.tier,
      entry.result,
      new Date().toISOString(),
      entry.report ?? null,
      entry.progressive ? 1 : 0,
    );
  }

  loadGateHistory(topicId: string): GateHistoryEntry[] {
    // 接线：第三重 guard 重算用，按 id 升序读全量，行→GateHistoryEntry 拼装。
    return (this.selectGateHistoryRows(topicId) as Record<string, SQLOutputValue>[]).map((r) =>
      this.mapGateHistoryRow(r),
    );
  }

  close(): void {
    // 接线：关 DatabaseSync 连接。
    this.db.close();
  }
}
