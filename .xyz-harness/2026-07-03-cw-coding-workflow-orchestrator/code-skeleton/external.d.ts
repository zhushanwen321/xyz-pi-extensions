/**
 * 外部依赖 ambient 声明（骨架编译用）。
 *
 * 骨架位于 .xyz-harness 下独立目录，无 node_modules。
 * Node 内置模块（node:sqlite / node:child_process / node:fs / node:path）
 * 与项目 SDK（typebox / pi-ai / pi-coding-agent）的类型在此声明，
 * 形状严格对照真实 API——adapter 代码（store/GateRunner/GitValidator）
 * 按真实方法签名调用，tsc 对此声明验签（Tier 2 SDK 证伪）。
 *
 * 实现期接入真实项目 tsconfig（paths 映射到 Pi SDK）后，本文件可删。
 */

// ── Node 全局（lib.dom 未引入，types:[] 不加载 @types/node）──
declare const process: { cwd(): string };
declare interface AbortSignal {
  readonly aborted: boolean;
}

// ── Node 内置：node:sqlite（D-016 存储层）──
declare module "node:sqlite" {
  export interface StatementResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  export class StatementSync {
    run(...parameters: unknown[]): StatementResult;
    get(...parameters: unknown[]): unknown;
    all(...parameters: unknown[]): unknown[];
    iterate(...parameters: unknown[]): IterableIterator<unknown>;
  }
  export class DatabaseSync {
    constructor(location: string, options?: { open?: boolean; enableDoubleQuotedStringLiterals?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

// ── Node 内置：node:child_process（GateRunner spawnSync + GitValidator execFileSync）──
declare module "node:child_process" {
  export interface SpawnSyncResult {
    status: number | null;
    stdout: string;
    stderr: string;
    signal?: string;
    pid: number;
  }
  export function spawnSync(
    command: string,
    args: string[],
    options?: { cwd?: string; encoding?: string; timeout?: number; input?: string },
  ): SpawnSyncResult;
  export function execFileSync(
    command: string,
    args?: string[],
    options?: { cwd?: string; encoding?: string; stdio?: string | string[] },
  ): string;
}

// ── Node 内置：node:fs / node:path ──
declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: string): string;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

declare module "node:path" {
  export function resolve(...paths: string[]): string;
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}

// ── @sinclair/typebox（项目既有依赖，plan-parser 真引）──
declare module "@sinclair/typebox" {
  export type TSchema = { kind: string };
  export const Type: {
    Object(properties: Record<string, unknown>, options?: Record<string, unknown>): TSchema;
    Literal(value: string): TSchema;
    String(options?: Record<string, unknown>): TSchema;
    Optional(schema: TSchema): TSchema;
    Array(schema: TSchema): TSchema;
    Number(options?: Record<string, unknown>): TSchema;
    Union(schemas: TSchema[]): TSchema;
  };
  export type Static<T> = Record<string, unknown>;
}

declare module "@sinclair/typebox/value" {
  export const Value: {
    Check(schema: unknown, value: unknown): boolean;
    Errors(schema: unknown, value: unknown): Iterable<{ message: string; path: string }>;
  };
}

// ── @earendil-works/pi-ai（StringEnum）──
// 返回 { kind: string } 与 typebox TSchema 结构兼容，让 Type.Optional(StringEnum(...)) 过 tsc。
declare module "@earendil-works/pi-ai" {
  export function StringEnum<T extends readonly string[]>(values: T): { kind: string };
}

// ── @mariozechner/pi-coding-agent（Pi SDK ExtensionAPI）──
declare module "@mariozechner/pi-coding-agent" {
  export interface ToolResult {
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, unknown>;
  }
  export interface ExtensionAPI {
    registerTool(config: {
      name: string;
      label?: string;
      description: string;
      executionMode?: "sequential" | "parallel";
      promptSnippet?: string;
      promptGuidelines?: string[];
      parameters: unknown;
      execute: (
        toolCallId: string,
        params: Record<string, unknown>,
        signal: AbortSignal | undefined,
      ) => Promise<ToolResult>;
    }): void;
  }
}
