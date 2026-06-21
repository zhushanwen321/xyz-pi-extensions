// no-unsafe-cast 规则测试（Round 1 MF#3）：
// 覆盖 4 个 AST 检测模式（as never / as any / as unknown as / 全可选结构断言）
// + isAllOptionalProperties 边界（空 members、混合可选/必填、非 TSTypeLiteral）。
// 用 ESLint 内置 RuleTester；vitest 仅做 describe/it 组织，不引入额外断言库。

import { describe, it } from "vitest";
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";
import rule from "../rules/no-unsafe-cast.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parser: tseslint.parser,
  },
});

describe("taste/no-unsafe-cast", () => {
  // ── Pattern 1: `as never` ──────────────────────────────
  it("reports `x as never`", () => {
    ruleTester.run("no-unsafe-cast", rule, {
      valid: [{ code: "const x = 1 as number;" }],
      invalid: [
        { code: "const x = 1 as never;", errors: [{ messageId: "castNever" }] },
      ],
    });
  });

  // ── Pattern 2: `as any` ────────────────────────────────
  it("reports `x as any`", () => {
    ruleTester.run("no-unsafe-cast", rule, {
      valid: [{ code: "const x = 1 as unknown;" }],
      invalid: [
        { code: "const x = 1 as any;", errors: [{ messageId: "castAny" }] },
      ],
    });
  });

  // ── Pattern 3: `as unknown as T` (double cast) ─────────
  it("reports double cast `as unknown as T`", () => {
    ruleTester.run("no-unsafe-cast", rule, {
      valid: [{ code: "const x = v as Foo;" }],
      invalid: [
        {
          code: "const x = v as unknown as Foo;",
          errors: [{ messageId: "doubleCast" }],
        },
      ],
    });
  });

  // ── Pattern 4: structural cast to all-optional type ────
  it("reports structural cast to all-optional type", () => {
    ruleTester.run("no-unsafe-cast", rule, {
      valid: [
        "const x = v as { a: number };", // 必填字段 → 不报
        "const x = v as { a: number; b?: string };", // 混合 → 不报
        "const x = v as {};", // 空 members → 不报
        "const x = v as string;", // 非 TSTypeLiteral → 不报
      ],
      invalid: [
        {
          code: "const x = v as { a?: number; b?: string };",
          errors: [{ messageId: "structuralCast" }],
        },
      ],
    });
  });

  // ── isAllOptionalProperties 边界：单可选属性也命中 ──────
  it("reports single all-optional property", () => {
    ruleTester.run("no-unsafe-cast", rule, {
      valid: [],
      invalid: [
        {
          code: "const x = v as { a?: number };",
          errors: [{ messageId: "structuralCast" }],
        },
      ],
    });
  });
});
