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

import { DatabaseSync } from "node:sqlite";

import type {
  CwAction,
  CwStatus,
  CwTopic,
  Evidence,
  GateHistoryEntry,
  GateHistorySeed,
  TestCase,
  TestCaseSeed,
  WaveSeed,
} from "./types.js";

// ── schema 版本（PRAGMA user_version，#11） ──────────────────

const SCHEMA_VERSION = 1;

// ── DDL（§8.1 architecture） ────────────────────────────────

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
    gate_passed TEXT
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
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    // 接线：建表 + user_version 校验 + 迁移（#11，未来 ALTER TABLE 链）。
    for (const stmt of DDL) {
      this.db.exec(stmt);
    }
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
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
      `INSERT INTO topic (topic_id, slug, tier, objective, workspace_path, created_at, status, plan_format, coverage, gate_passed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    stmt.run(
      topic.topicId,
      topic.slug,
      topic.tier,
      topic.objective,
      topic.workspacePath,
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

  /** 行 → CwTopic 拼装（数据组装，叶子留 ⑥Wave）。 */
  private assembleTopic(
    topicRow: unknown,
    waveRows: unknown[],
    testCaseRows: unknown[],
    gateHistoryRows: unknown[],
  ): CwTopic {
    void topicRow;
    void waveRows;
    void testCaseRows;
    void gateHistoryRows;
    throw new Error("not implemented: assembleTopic 行→逻辑模型拼装（⑥Wave 落地）");
  }

  updateStatus(topicId: string, status: CwStatus): void {
    // 接线：prepare + run。
    this.db.prepare(`UPDATE topic SET status = ? WHERE topic_id = ?`).run(status, topicId);
  }

  updateGatePassed(topicId: string, phase: CwAction, passed: boolean): void {
    // 数据流：gate_passed 是 topic 表 JSON 列（Partial<Record<CwAction,boolean>> 串）。
    // 读现 JSON → 改一 phase → 写回。叶子：JSON 读改写留 ⑥Wave（避免半完成副作用）。
    void topicId;
    void phase;
    void passed;
    throw new Error("not implemented: updateGatePassed JSON 读改写（⑥Wave 落地）");
  }

  setEvidence(topicId: string, evidence: Evidence): void {
    // 接线：closeout 终态填充（coverage + gateHistory 快照）。
    void evidence;
    this.db.prepare(`UPDATE topic SET coverage = ? WHERE topic_id = ?`).run(
      evidence.coverage ?? null,
      topicId,
    );
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
      `INSERT INTO test_case (topic_id, id, layer, scenario, steps, expected, assertion, executor, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
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
      );
    }
  }

  updateTestCase(topicId: string, caseId: string, patch: Partial<TestCase>): void {
    // 接线：test action 逐条 patch（status/actual/screenshot/commitHash/judgedAt/failureReason）。
    // 数据流：动态拼 SET 子句按 patch 键。叶子：拼装留 ⑥Wave（避免 SQL 注入：列名白名单）。
    void patch;
    this.db.prepare(`UPDATE test_case SET status = ? WHERE topic_id = ? AND id = ?`).run(
      patch.status ?? "pending",
      topicId,
      caseId,
    );
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
    // 接线：第三重 guard 重算用，按 id 升序读全量。
    return this.selectGateHistoryRows(topicId) as GateHistoryEntry[];
  }

  close(): void {
    // 接线：关 DatabaseSync 连接。
    this.db.close();
  }
}
