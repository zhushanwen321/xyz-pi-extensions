/**
 * plan-parser — 3 套 JSON schema 解析（D-006，#5 方案 A typebox）。
 *
 * 输入：plan.json / clarify.json / detail.json（skill 阶段产出，§12 architecture）。
 * 校验：format 字段 === topic.tier 锁定值（D-003 tier 锁定）+ typebox Value.Check 结构。
 * 输出：ParsedXxx，供 action handler 写入 _cw.db（waves/testCases）。
 *
 * 真引 typebox Value（Tier 2 证伪）。
 */

import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { TestCaseSeed, Tier, WaveSeed } from "./types.js";

// ── 3 套 schema（§12 architecture，typebox 声明） ────────────

const LitePlanSchema = Type.Object({
  format: Type.Literal("lite"),
  objective: Type.String(),
  waves: Type.Array(
    Type.Object({
      id: Type.String(),
      changes: Type.Array(Type.String()),
      dependsOn: Type.Array(Type.String()),
      parallelGroup: Type.Optional(Type.String()),
    }),
  ),
  testCases: Type.Array(
    Type.Object({
      id: Type.String(),
      layer: Type.Union([Type.Literal("mock"), Type.Literal("real")]),
      scenario: Type.String(),
      steps: Type.String(),
      expected: Type.Object({
        url: Type.Optional(Type.String()),
        text: Type.Optional(Type.String()),
      }),
      executor: Type.String(),
    }),
  ),
});

const MidClarifySchema = Type.Object({
  format: Type.Literal("mid-clarify"),
  objective: Type.String(),
  deliverables: Type.Object({
    requirements: Type.String(),
    systemArchitecture: Type.String(),
  }),
});

const MidDetailSchema = Type.Object({
  format: Type.Literal("mid-detail"),
  objective: Type.String(),
  waves: Type.Array(
    Type.Object({
      id: Type.String(),
      issues: Type.Array(Type.String()),
      dependsOn: Type.Array(Type.String()),
      parallelGroup: Type.Optional(Type.String()),
    }),
  ),
  testCases: Type.Array(
    Type.Object({
      id: Type.String(),
      layer: Type.Union([
        Type.Literal("unit"),
        Type.Literal("integration"),
        Type.Literal("e2e"),
        Type.Literal("perf-chaos"),
      ]),
      scenario: Type.String(),
      steps: Type.String(),
      assertion: Type.String(),
      executor: Type.String(),
    }),
  ),
  deliverables: Type.Object({
    issues: Type.String(),
    nonFunctional: Type.String(),
    codeArchitecture: Type.String(),
    executionPlan: Type.String(),
  }),
});

// ── 解析结果类型 ─────────────────────────────────────────────

export interface ParsedLitePlan {
  waves: WaveSeed[];
  testCases: TestCaseSeed[];
}

export interface ParsedMidClarify {
  deliverables: { requirements: string; systemArchitecture: string };
}

export interface ParsedMidDetail {
  waves: WaveSeed[];
  testCases: TestCaseSeed[];
  deliverables: {
    issues: string;
    nonFunctional: string;
    codeArchitecture: string;
    executionPlan: string;
  };
}

// ── 解析函数 ─────────────────────────────────────────────────

/** 共用：format 锁定校验（D-003，AC-5.2）。 */
function assertFormat(json: unknown, expectedFormat: string, tier: Tier): void {
  // 数据流：json.format 必须 === 预期（tier 锁定值）。不匹配 → throw（gate fail，status 不变）。
  if (typeof json !== "object" || json === null) {
    throw new Error(`invalid plan json: not an object`);
  }
  const format = (json as { format?: unknown }).format;
  if (format !== expectedFormat) {
    throw new Error(
      `tier mismatch: json.format="${String(format)}" but topic.tier="${tier}" ` +
        `(tier locked at create, D-003; 作废重建)`,
    );
  }
}

/** 共用：typebox Value.Check + 报错。 */
function assertSchema(schema: unknown, json: unknown, label: string): void {
  // 接线：真引 typebox Value.Check（Tier 2 证伪）。
  if (!Value.Check(schema, json)) {
    const errors = Array.from(Value.Errors(schema, json))
      .map((e) => `${e.path}: ${e.message}`)
      .slice(0, 5)
      .join("; ");
    throw new Error(`invalid ${label} json: ${errors}`);
  }
}

export function parseLitePlan(json: unknown, tier: Tier): ParsedLitePlan {
  // 接线：format 锁定 → schema 校验 → extract。
  assertFormat(json, "lite", tier);
  assertSchema(LitePlanSchema, json, "lite plan");
  return extractLitePlan(json);
}

export function parseMidClarify(json: unknown, tier: Tier): ParsedMidClarify {
  // 接线：format 锁定 → schema 校验 → extract。
  assertFormat(json, "mid-clarify", tier);
  assertSchema(MidClarifySchema, json, "mid clarify");
  return extractMidClarify(json);
}

export function parseMidDetail(json: unknown, tier: Tier): ParsedMidDetail {
  // 接线：format 锁定 → schema 校验 → extract。
  assertFormat(json, "mid-detail", tier);
  assertSchema(MidDetailSchema, json, "mid detail");
  return extractMidDetail(json);
}

// ── extract（叶子，⑥Wave） ──────────────────────────────────

function extractLitePlan(json: unknown): ParsedLitePlan {
  // 数据流：json.waves/testCases → WaveSeed[]/TestCaseSeed[]（id/changes/dependsOn/expected）。
  void json;
  throw new Error("not implemented: extractLitePlan（⑥Wave 落地）");
}

function extractMidClarify(json: unknown): ParsedMidClarify {
  void json;
  throw new Error("not implemented: extractMidClarify（⑥Wave 落地）");
}

function extractMidDetail(json: unknown): ParsedMidDetail {
  void json;
  throw new Error("not implemented: extractMidDetail（⑥Wave 落地）");
}
