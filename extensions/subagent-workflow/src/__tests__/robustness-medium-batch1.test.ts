// Medium batch 1 robustness fixes verification
//
// M4: dispatchAgentCall .then() clears node.live BEFORE stale guard (not after)
// M7: handleWorkerMessage validates msg shape before dereferencing msg.opts
// M8: session-reconstructor guards Array.isArray(msg.content) before for...of

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, "..", "..");

function readSrc(relPath: string): string {
  return readFileSync(join(PKG_ROOT, relPath), "utf-8");
}

// ── M4: node.live cleared before stale guard ─────────────────

describe("M4: dispatchAgentCall .then() clears node.live before stale guard", () => {
  const src = readSrc(join("src", "orchestration", "error-recovery.ts"));

  it("node.live = undefined appears before the stale guard return", () => {
    // 找到 .then 回调中的 stale guard 和 node.live 清理的相对顺序
    const thenMatch = src.match(/\.then\(\(\)\s*=>\s*\{[\s\S]*?\}\)/);
    expect(thenMatch).toBeTruthy();
    const thenBlock = thenMatch![0];

    const liveIdx = thenBlock.indexOf("node.live = undefined");
    const guardIdx = thenBlock.indexOf('run.state.status !== "running"');

    expect(liveIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(-1);
    // node.live 清理必须在 stale guard 之前（代码行号更小）
    expect(liveIdx).toBeLessThan(guardIdx);
  });
});

// ── M7: handleWorkerMessage shape validation ─────────────────

describe("M7: handleWorkerMessage validates msg before dereferencing", () => {
  const src = readSrc(join("src", "orchestration", "error-recovery.ts"));

  it("handleWorkerMessage has shape guard for msg before dereferencing opts", () => {
    // handleWorkerMessage 中 `raw as WorkerMsg` 后应有 typeof/形状校验
    // 防止畸形 IPC 消息（msg.opts undefined）导致 TypeError
    const handlerMatch = src.match(/export async function handleWorkerMessage[\s\S]*?switch/);
    expect(handlerMatch).toBeTruthy();
    const handlerBlock = handlerMatch![0];
    // 在 switch 前应有 msg 形状校验（typeof msg === 'object' 或 msg?.type 检查）
    expect(handlerBlock).toMatch(/typeof\s+(msg|raw)|!\s*(msg|raw)|(msg|raw)\s*&&/);
  });
});

// ── M8: reconstructor Array.isArray guard ────────────────────

describe("M8: session-reconstructor guards msg.content with Array.isArray", () => {
  const src = readSrc(join("src", "execution", "session-reconstructor.ts"));

  it("for...of msg.content is guarded by Array.isArray", () => {
    // 验证 for (const block of msg.content) 前有 Array.isArray 守卫
    expect(src).toContain("Array.isArray");
    // 确保守卫与 msg.content 相关
    const contentGuardMatch = src.match(/Array\.isArray\([^)]*content[^)]*\)/);
    expect(contentGuardMatch).toBeTruthy();
  });
});
