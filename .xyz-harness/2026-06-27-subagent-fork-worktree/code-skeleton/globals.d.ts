// code-skeleton/globals.d.ts — ⑤骨架 Node API 最小环境声明
// 骨架是设计验证产物（非实际包），不依赖 @types/node。此处声明骨架用到的 Node API
// 最小签名，供 tsc 验证类型自洽 + Level 1 接线调用链签名匹配（SKILL skeleton-spike 验证目标）。
// 实际包 extensions/subagents 用完整 @types/node（⑥Wave）。

declare module "node:fs" {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
  }
  export function writeFileSync(file: string, data: string, encoding: string): void;
  export function writeFileSync(file: string, data: string): void;
  export function readFileSync(file: string, encoding: string): string;
  export function existsSync(path: string): boolean;
  export function unlinkSync(path: string): void;
  export function statSync(path: string): { mtimeMs: number };
  export function readdirSync(path: string, opts: { withFileTypes: true }): Dirent[];
  export function symlinkSync(target: string, path: string, type: string): void;
}

declare module "node:child_process" {
  export function execFileSync(
    command: string,
    args: string[],
    options: {
      cwd: string;
      encoding: string;
      stdio: unknown;
      timeout?: number;
    },
  ): string;
}

declare module "node:path" {
  export function join(...paths: string[]): string;
  export function dirname(path: string): string;
}

declare const process: {
  pid: number;
  kill(pid: number, signal: number): void;
  readonly env: Record<string, string | undefined>;
};

declare function setTimeout(callback: () => void, ms: number): unknown;

// AbortSignal/AbortController（DOM lib，骨架独立声明）
declare class AbortSignal {
  aborted: boolean;
  addEventListener(type: "abort", listener: () => void, opts?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void): void;
}
declare class AbortController {
  readonly signal: AbortSignal;
  abort(): void;
}
