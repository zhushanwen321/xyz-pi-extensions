/**
 * store.ts 单测 — CwStore 真实 sqlite 层（real tier）。
 *
 * 覆盖 NFR 代码测试项（归本 Wave）：
 *   T2.11  SQL 参数化拒绝拼接（#1 安全 / AC-1.5）
 *   T2.12  多表写事务边界——中途抛错 ROLLBACK 无半写（#1 数据 / AC-1.2）
 *   T2.13  事务 COMMIT 后 gateHistory 落库且绑定 topicId（#1 可观测）
 *   T2.27  user_version 迁移：旧 db（v0）打开新 CwStore 自动迁移 + 数据保留（#11 数据）
 *   T2.28  迁移日志含 from/to version（#11 可观测）
 *
 * 另含 assembleTopic / updateGatePassed / updateTestCase 三个叶子的直接验证
 * （round-trip + 字段 patch）——TDD 要求每个实现的叶子有对应测试。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CwStore, SCHEMA_VERSION } from "../store.js";
import type { CwTopic, GateHistorySeed, TestCaseSeed, WaveSeed } from "../types.js";

// ── helpers ──────────────────────────────────────────────────

/** 每次返回一个新的临时 .db 文件路径（独立目录，互不污染）。 */
function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "cw-store-test-"));
  return join(dir, "test.db");
}

/** 构造最小可写 CwTopic（insertTopic 入参形状）。 */
function makeTopic(overrides: Partial<CwTopic> = {}): CwTopic {
  return {
    schemaVersion: 1,
    topicId: "t-1",
    slug: "demo",
    tier: "lite",
    objective: "build X",
    workspacePath: "/tmp/ws",
    topicDir: "/tmp/ws/.xyz-harness/demo",
    createdAt: "2026-07-04T00:00:00.000Z",
    status: "created",
    planFormat: "lite",
    waves: [],
    testCases: [],
    gateHistory: [],
    gatePassed: {},
    ...overrides,
  };
}

const sampleWave: WaveSeed = {
  id: "w1",
  dependsOn: [],
  parallelGroup: "g1",
  changes: ["src/a.ts"],
  issues: ["#1"],
};

const sampleCase: TestCaseSeed = {
  id: "E1",
  layer: "real",
  scenario: "登录成功",
  steps: "打开 /login → 提交",
  expected: { url: "/profile", text: "用户名" },
  executor: "vitest",
};

const sampleGate: GateHistorySeed = {
  phase: "plan",
  action: "plan",
  gate: "check_plan",
  tier: "weak-structural",
  result: "pass",
  progressive: false,
};

// 每个测试自行 new CwStore + close；这里只兜底清理临时目录。
const tmpDirsToClean: string[] = [];
afterEach(() => {
  while (tmpDirsToClean.length > 0) {
    const d = tmpDirsToClean.pop();
    try {
      rmSync(d!, { recursive: true, force: true });
    } catch (e) {
      void e; // best-effort 清理：tmp 目录由 OS 兜底，单次清理失败不阻断测试
    }
  }
});

/** 记录临时目录以便 afterEach 清理。 */
function trackTmpDir(path: string): string {
  const dir = join(path, "..");
  tmpDirsToClean.push(dir);
  return path;
}

// ── assembleTopic round-trip（叶子直接验证） ─────────────────

describe("CwStore.loadTopic — 行→CwTopic 拼装（assembleTopic 叶子）", () => {
  it("insert 完整 topic + wave + testCase + gateHistory → loadTopic 等价回读", () => {
    const store = new CwStore(":memory:");
    const seed = makeTopic({ gatePassed: { plan: true } });
    store.insertTopic(seed);
    store.insertWaves(seed.topicId, [sampleWave]);
    store.insertTestCases(seed.topicId, [sampleCase]);
    store.appendGateHistory(seed.topicId, sampleGate);

    const loaded = store.loadTopic(seed.topicId);
    expect(loaded).not.toBeNull();
    if (!loaded) return;

    // topic 列
    expect(loaded.topicId).toBe("t-1");
    expect(loaded.slug).toBe("demo");
    expect(loaded.tier).toBe("lite");
    expect(loaded.objective).toBe("build X");
    expect(loaded.workspacePath).toBe("/tmp/ws");
    expect(loaded.status).toBe("created");
    expect(loaded.planFormat).toBe("lite");
    expect(loaded.schemaVersion).toBe(SCHEMA_VERSION);
    // gate_passed JSON 列读改写
    expect(loaded.gatePassed).toEqual({ plan: true });

    // wave：JSON 列 parse + committed null
    expect(loaded.waves).toHaveLength(1);
    const w = loaded.waves[0]!;
    expect(w.id).toBe("w1");
    expect(w.dependsOn).toEqual([]);
    expect(w.parallelGroup).toBe("g1");
    expect(w.committed).toBeNull();
    expect(w.changes).toEqual(["src/a.ts"]);
    expect(w.issues).toEqual(["#1"]);

    // testCase：expected JSON + status pending（insertTestCases 默认）
    expect(loaded.testCases).toHaveLength(1);
    const c = loaded.testCases[0]!;
    expect(c.id).toBe("E1");
    expect(c.layer).toBe("real");
    expect(c.scenario).toBe("登录成功");
    expect(c.expected).toEqual({ url: "/profile", text: "用户名" });
    expect(c.executor).toBe("vitest");
    expect(c.status).toBe("pending");

    // gateHistory：progressive 0→false，ts/id 由 DB 生成
    expect(loaded.gateHistory).toHaveLength(1);
    const g = loaded.gateHistory[0]!;
    expect(g.phase).toBe("plan");
    expect(g.action).toBe("plan");
    expect(g.gate).toBe("check_plan");
    expect(g.tier).toBe("weak-structural");
    expect(g.result).toBe("pass");
    expect(g.progressive).toBe(false);
    expect(typeof g.id).toBe("number");
    expect(typeof g.ts).toBe("string");

    store.close();
  });

  it("topic 不存在 → loadTopic 返回 null", () => {
    const store = new CwStore(":memory:");
    expect(store.loadTopic("nonexistent")).toBeNull();
    store.close();
  });

  it("gate_passed 为空对象/无列值时回退为 {}", () => {
    const store = new CwStore(":memory:");
    const seed = makeTopic({ gatePassed: {} });
    store.insertTopic(seed);
    const loaded = store.loadTopic(seed.topicId);
    expect(loaded?.gatePassed).toEqual({});
    store.close();
  });
});

// ── updateGatePassed（JSON 读改写叶子） ──────────────────────

describe("CwStore.updateGatePassed — JSON 读改写", () => {
  it("在现有 gatePassed 上追加一个 phase，不影响其他 phase", () => {
    const store = new CwStore(":memory:");
    const seed = makeTopic({ gatePassed: { plan: true } });
    store.insertTopic(seed);

    store.updateGatePassed(seed.topicId, "dev", true);
    store.updateGatePassed(seed.topicId, "plan", false);

    const loaded = store.loadTopic(seed.topicId);
    expect(loaded?.gatePassed).toEqual({ plan: false, dev: true });
    store.close();
  });
});

// ── updateTestCase（动态 SET + 列名白名单叶子） ──────────────

describe("CwStore.updateTestCase — 动态 SET", () => {
  it("patch status + actual + failureReason + screenshotPath + commitHash + judgedAt 全字段", () => {
    const store = new CwStore(":memory:");
    store.insertTopic(makeTopic());
    store.insertTestCases("t-1", [sampleCase]);

    store.updateTestCase("t-1", "E1", {
      status: "failed",
      actual: { url: "/login", text: "错误" },
      failureReason: "url mismatch",
      screenshotPath: "/tmp/shot.png",
      commitHash: "abc123",
      judgedAt: "2026-07-04T01:00:00.000Z",
    });

    const loaded = store.loadTopic("t-1");
    const c = loaded?.testCases[0];
    expect(c?.status).toBe("failed");
    expect(c?.actual).toEqual({ url: "/login", text: "错误" });
    expect(c?.failureReason).toBe("url mismatch");
    expect(c?.screenshotPath).toBe("/tmp/shot.png");
    expect(c?.commitHash).toBe("abc123");
    expect(c?.judgedAt).toBe("2026-07-04T01:00:00.000Z");
    store.close();
  });

  it("patch 空（无白名单字段）→ 不抛、不改 status", () => {
    const store = new CwStore(":memory:");
    store.insertTopic(makeTopic());
    store.insertTestCases("t-1", [sampleCase]);

    expect(() => store.updateTestCase("t-1", "E1", {})).not.toThrow();
    const loaded = store.loadTopic("t-1");
    expect(loaded?.testCases[0]?.status).toBe("pending");
    store.close();
  });
});

// ── T2.11 SQL 参数化（#1 安全 / AC-1.5） ─────────────────────

describe("T2.11 — SQL 参数化拒绝拼接（注入字符串当字面值）", () => {
  it("含 SQL 注入语法的 topicId 作为字面值存储，表不被破坏", () => {
    const store = new CwStore(":memory:");
    const malicious = "'; DROP TABLE topic; --";
    // 用恶意 topicId insert → 应被参数化当普通字符串存
    store.insertTopic(makeTopic({ topicId: malicious }));

    // 同样恶意串读回 → 命中刚插入的行（证明是字面匹配，不是 SQL 拼接）
    const loaded = store.loadTopic(malicious);
    expect(loaded?.topicId).toBe(malicious);

    // topic 表仍在（未被 DROP）——再插一条正常 id 验证可写可读
    store.insertTopic(makeTopic({ topicId: "safe-id", objective: "still here" }));
    expect(store.loadTopic("safe-id")?.objective).toBe("still here");
    store.close();
  });
});

// ── T2.12 多表写事务边界（#1 数据 / AC-1.2） ─────────────────

describe("T2.12 — transaction 中途抛错 ROLLBACK 无半写", () => {
  it("事务内 updateStatus 后抛错 → 状态回滚为原值", () => {
    const store = new CwStore(":memory:");
    store.insertTopic(makeTopic({ status: "created" })); // 初始 created

    expect(() =>
      store.transaction(() => {
        store.updateStatus("t-1", "planned"); // 半写
        throw new Error("boom mid-transaction");
      }),
    ).toThrow("boom mid-transaction");

    // 回读：status 应仍是 created（未持久化半写）
    expect(store.loadTopic("t-1")?.status).toBe("created");
    store.close();
  });

  it("事务正常 COMMIT → 状态持久化", () => {
    const store = new CwStore(":memory:");
    store.insertTopic(makeTopic({ status: "created" }));

    store.transaction(() => {
      store.updateStatus("t-1", "planned");
      return "ok";
    });

    expect(store.loadTopic("t-1")?.status).toBe("planned");
    store.close();
  });
});

// ── T2.13 事务 COMMIT 落 gateHistory 且绑定 topicId（#1 可观测） ─

describe("T2.13 — transaction COMMIT 后 gateHistory 落库绑定 topicId", () => {
  it("事务内 appendGateHistory → commit → loadGateHistory 命中且绑定正确 topicId", () => {
    const store = new CwStore(":memory:");
    store.insertTopic(makeTopic({ topicId: "t-1" }));
    store.insertTopic(makeTopic({ topicId: "t-2", slug: "other" }));

    store.transaction(() => {
      store.appendGateHistory("t-1", sampleGate);
    });

    // t-1 命中 1 条
    const h1 = store.loadGateHistory("t-1");
    expect(h1).toHaveLength(1);
    expect(h1[0]?.gate).toBe("check_plan");
    expect(h1[0]?.result).toBe("pass");
    // t-2 无记录（证明 topic_id 绑定，未串台）
    expect(store.loadGateHistory("t-2")).toHaveLength(0);
    // 不存在的 topic 也为空
    expect(store.loadGateHistory("never")).toHaveLength(0);
    store.close();
  });
});

// ── T2.27 user_version 迁移 + 数据保留（#11 数据） ───────────

describe("T2.27 — 旧 db（user_version=0）打开新 CwStore 自动迁移 + 数据保留", () => {
  it("v0 库（无 user_version）→ 新 CwStore 升到 SCHEMA_VERSION 且已有数据不丢", () => {
    const dbPath = trackTmpDir(tmpDbPath());

    // 1. 模拟旧库：手写 v1 topic 表结构 + 插一行，user_version 保持默认 0
    const raw = new DatabaseSync(dbPath);
    raw.exec(`CREATE TABLE topic (
      topic_id TEXT PRIMARY KEY, slug TEXT NOT NULL, tier TEXT NOT NULL, objective TEXT NOT NULL,
      workspace_path TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL,
      plan_format TEXT, coverage INTEGER, gate_passed TEXT
    )`);
    raw
      .prepare(
        `INSERT INTO topic (topic_id, slug, tier, objective, workspace_path, created_at, status, gate_passed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "legacy-1",
        "legacy",
        "lite",
        "legacy objective",
        "/tmp/legacy",
        "2026-01-01T00:00:00.000Z",
        "created",
        "{}",
      );
    const before = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(before.user_version).toBe(0);
    raw.close();

    // 2. 新 CwStore 打开 → init 读 user_version=0 → 迁移链 → 升版本
    const store = new CwStore(dbPath);

    // 3. 已有数据保留 + 可读
    const loaded = store.loadTopic("legacy-1");
    expect(loaded?.objective).toBe("legacy objective");
    expect(loaded?.slug).toBe("legacy");
    expect(loaded?.status).toBe("created");

    // 4. user_version 升到 SCHEMA_VERSION（经第二连接读，避免动 store 私有 db）
    const verify = new DatabaseSync(dbPath);
    const after = verify.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(after.user_version).toBe(SCHEMA_VERSION);
    verify.close();

    store.close();
  });
});

// ── T2.28 迁移日志 from/to version（#11 可观测） ─────────────

describe("T2.28 — 迁移日志含 from/to version", () => {
  it("触发迁移时向 stderr 落 JSON 日志含 from=0 to=SCHEMA_VERSION", () => {
    const writeSpy = vi.spyOn(process.stderr, "write");

    // 全新 :memory: 库，user_version 默认 0 → 构造时触发 0→1 迁移
    const store = new CwStore(":memory:");
    store.close();

    // 从所有 stderr.write 调用中筛出 cw-migration 事件
    const migrationLogs: Array<{ from: number; to: number }> = [];
    for (const call of writeSpy.mock.calls) {
      const chunk = call[0];
      if (typeof chunk !== "string") continue;
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t.includes("cw-migration")) continue;
        try {
          const obj = JSON.parse(t) as Record<string, unknown>;
          if (
            obj.event === "cw-migration" &&
            typeof obj.from === "number" &&
            typeof obj.to === "number"
          ) {
            migrationLogs.push({ from: obj.from, to: obj.to });
          }
        } catch (e) {
          void e; // 非 JSON 行跳过
        }
      }
    }

    expect(migrationLogs).toContainEqual({ from: 0, to: SCHEMA_VERSION });
    writeSpy.mockRestore();
  });
});

// ============================================================
// ADR-029 决策 6：WAL + busy_timeout 契约测试
// ============================================================

describe("CwStore WAL + busy_timeout (ADR-029 decision 6)", () => {
  it("构造后 journal_mode=WAL", () => {
    const dbPath = tmpDbPath();
    const store = new CwStore(dbPath);
    const row = store["db"].prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    store.close();
    // 内存库返回 "memory"，文件库返回 "wal"。两者都应不报错且可查询。
    // 文件库（生产路径）必须是 wal。
    expect(row?.journal_mode).toMatch(/^(wal|memory)$/);
    if (dbPath.includes("test.db")) {
      expect(row?.journal_mode).toBe("wal");
    }
  });

  it("构造后 busy_timeout=5000", () => {
    const store = new CwStore(":memory:");
    const row = store["db"].prepare("PRAGMA busy_timeout").get() as { timeout?: number } | undefined;
    store.close();
    expect(row?.timeout).toBe(5000);
  });
});
