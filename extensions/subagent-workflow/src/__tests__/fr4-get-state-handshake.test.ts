import { describe, it, expect } from "vitest";
import { sendGetStateCommand } from "../execution/stdin-writer";
import { parseSpawnLine } from "../execution/spawn-event-adapter";

describe("FR-4: get_state RPC handshake", () => {
  describe("sendGetStateCommand", () => {
    it("should write get_state command to stdin", () => {
      const written: string[] = [];
      const child = {
        stdin: {
          destroyed: false,
          write: (data: string) => {
            written.push(data);
            return true;
          },
        },
      } as unknown as Parameters<typeof sendGetStateCommand>[0];

      const id = sendGetStateCommand(child);

      expect(written).toHaveLength(1);
      const parsed = JSON.parse(written[0]);
      expect(parsed.type).toBe("get_state");
      expect(parsed.id).toBe(id);
      expect(typeof parsed.id).toBe("string");
    });

    it("should not write if stdin is destroyed", () => {
      const written: string[] = [];
      const child = {
        stdin: {
          destroyed: true,
          write: (data: string) => {
            written.push(data);
            return true;
          },
        },
      } as unknown as Parameters<typeof sendGetStateCommand>[0];

      sendGetStateCommand(child);

      expect(written).toHaveLength(0);
    });

    it("should not write if stdin is null", () => {
      const child = {
        stdin: null,
      } as unknown as Parameters<typeof sendGetStateCommand>[0];

      // Should not throw
      sendGetStateCommand(child);
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

  describe("get_state response matching in stdout pump", () => {
    it("should match response by command and id", () => {
      // Simulate the matching logic from session-runner
      const listeners = new Map<string, (data: unknown) => void>();
      let resolvedData: unknown = undefined;

      const reqId = "test-request-123";
      listeners.set(reqId, (data) => {
        resolvedData = data;
      });

      // Simulate parsing a response
      const line = JSON.stringify({
        type: "response",
        command: "get_state",
        success: true,
        id: reqId,
        data: { sessionFile: "/test/session.jsonl", sessionId: "sess-1" },
      });

      const parsed = parseSpawnLine(line);
      expect(parsed).not.toBeNull();
      expect(parsed!.kind).toBe("response");

      if (parsed!.kind === "response") {
        if (parsed.command === "get_state" && parsed.success && parsed.id) {
          const resolver = listeners.get(parsed.id);
          if (resolver) {
            listeners.delete(parsed.id);
            resolver(parsed.data);
          }
        }
      }

      expect(resolvedData).toEqual({
        sessionFile: "/test/session.jsonl",
        sessionId: "sess-1",
      });
      expect(listeners.has(reqId)).toBe(false);
    });

    it("should not match response with wrong id", () => {
      const listeners = new Map<string, (data: unknown) => void>();
      let resolved = false;

      listeners.set("correct-id", () => {
        resolved = true;
      });

      const line = JSON.stringify({
        type: "response",
        command: "get_state",
        success: true,
        id: "wrong-id",
        data: { sessionFile: "/test/session.jsonl" },
      });

      const parsed = parseSpawnLine(line);
      if (parsed!.kind === "response") {
        if (parsed.command === "get_state" && parsed.success && parsed.id) {
          const resolver = listeners.get(parsed.id);
          if (resolver) {
            resolver(parsed.data);
          }
        }
      }

      expect(resolved).toBe(false);
    });

    it("should not match failed response", () => {
      const listeners = new Map<string, (data: unknown) => void>();
      let resolved = false;

      listeners.set("test-id", () => {
        resolved = true;
      });

      const line = JSON.stringify({
        type: "response",
        command: "get_state",
        success: false,
        id: "test-id",
        error: "not ready",
      });

      const parsed = parseSpawnLine(line);
      if (parsed!.kind === "response") {
        // The matching logic only fires for success responses
        if (parsed.command === "get_state" && parsed.success && parsed.id) {
          const resolver = listeners.get(parsed.id);
          if (resolver) {
            resolver(parsed.data);
          }
        }
      }

      expect(resolved).toBe(false);
    });
  });
});
