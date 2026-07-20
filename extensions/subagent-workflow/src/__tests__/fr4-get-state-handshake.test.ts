import { describe, expect, it, vi } from "vitest";

import { ChildRpcChannel } from "../execution/rpc-channel";
import { parseSpawnLine } from "../execution/spawn-event-adapter";
import { sendGetStateCommand } from "../execution/stdin-writer";

/** 构造 minimal child (EventEmitter) + 包成 ChildRpcChannel，供 sendGetStateCommand 测试。 */
function makeChannel(stdin: { destroyed: boolean; write: (data: string) => boolean; on?: unknown } | null): ChildRpcChannel {
  const child = {
    stdin,
    on: vi.fn(),
  } as unknown as ConstructorParameters<typeof ChildRpcChannel>[0];
  return new ChildRpcChannel(child);
}

describe("FR-4: get_state RPC handshake", () => {
  describe("sendGetStateCommand", () => {
    it("should write get_state command to stdin", () => {
      const written: string[] = [];
      const channel = makeChannel({
        destroyed: false,
        write: (data: string) => {
          written.push(data);
          return true;
        },
        on: vi.fn(),
      });

      const id = sendGetStateCommand(channel);

      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0]);
      expect(parsed.type).toBe("get_state");
      expect(parsed.id).toBe(id);
      expect(typeof parsed.id).toBe("string");
    });

    it("should not write if stdin is destroyed", () => {
      const written: string[] = [];
      const channel = makeChannel({
        destroyed: true,
        write: (data: string) => {
          written.push(data);
          return true;
        },
        on: vi.fn(),
      });

      sendGetStateCommand(channel);

      expect(written).toHaveLength(0);
      expect(channel.isDead).toBe(true);
    });

    it("should not write if stdin is null", () => {
      // stdin=null 时 ChildRpcChannel 构造不挂 stdin listener（optional chaining 短路），
      // channel.write guard 跳过写入并置位 dead。
      const channel = makeChannel(null);

      // Should not throw
      sendGetStateCommand(channel);
      expect(channel.isDead).toBe(true);
    });
  });

  describe("parseSpawnLine: get_state response", () => {
    it("should parse get_state response correctly", () => {
      const line = JSON.stringify({
        type: "response",
        command: "get_state",
        success: true,
        id: "test-req-id",
        data: {
          sessionFile: "/path/to/session.jsonl",
          sessionId: "session-123",
        },
      });

      const parsed = parseSpawnLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("response");
      if (parsed!.kind === "response") {
        expect(parsed!.command).toBe("get_state");
        expect(parsed!.success).toBe(true);
        expect(parsed!.id).toBe("test-req-id");
        expect(parsed!.data).toEqual({
          sessionFile: "/path/to/session.jsonl",
          sessionId: "session-123",
        });
      }
    });

    it("should parse get_state error response", () => {
      const line = JSON.stringify({
        type: "response",
        command: "get_state",
        success: false,
        id: "test-req-id",
        error: "session not initialized",
      });

      const parsed = parseSpawnLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("response");
      if (parsed!.kind === "response") {
        expect(parsed!.command).toBe("get_state");
        expect(parsed!.success).toBe(false);
        expect(parsed!.error).toBe("session not initialized");
      }
    });

    it("should parse get_state response without id (notification)", () => {
      const line = JSON.stringify({
        type: "response",
        command: "get_state",
        success: true,
        data: { sessionId: "session-456" },
      });

      const parsed = parseSpawnLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("response");
      if (parsed!.kind === "response") {
        expect(parsed!.command).toBe("get_state");
        expect(parsed!.id).toBeUndefined();
      }
    });
  });

  // [B8] 删除原 "get_state response matching in stdout pump" describe 块（3 case）：
  // 该块在测试内重写了 session-runner 的 response matching 逻辑（Map<id,resolver> +
  //  delete + resolver(data)），断言的是测试自己复制的逻辑而非生产代码——tautological
  // （同义反复），无法捕获生产 matching 的真实回归。真实覆盖已在 run-spawn-rpc-mode.test.ts
  // （端到端跑 session-runner 的 stdout pump + get_state 握手）中存在，此处删除不减覆盖。
});
