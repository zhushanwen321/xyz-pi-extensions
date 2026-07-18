// src/execution/get-state-handshake.ts
//
// FR-4: get_state RPC 握手逻辑。
//
// 从 session-runner.ts 提取（保持文件 < 1000 行）。职责单一：通过 get_state RPC
// 查询子进程 sessionFile/sessionId，带超时重试。session-runner spawn 后无条件调用。
//
// 设计要点：
//   - 重试节奏：单次超时 GET_STATE_TIMEOUT_MS（2s）后，等 GET_STATE_RETRY_INTERVAL_MS（500ms）
//     再发起下一次 get_state，最多 GET_STATE_MAX_RETRIES（3）次。修复点：旧实现超时后
//     立即递归 tryOnce()，GET_STATE_RETRY_INTERVAL_MS 声明了却从未使用（eslint error 阻断），
//     现在让常量名与行为一致——重试前真的等间隔。
//   - 加速路径：sessionFile 一旦拿到立即 resolve（不等剩余重试）。
//   - 全部超时：resolve 空对象（调用方走兜底查找）。

import type { ChildProcess } from "node:child_process";

import { sendGetStateCommand } from "./stdin-writer.ts";

/** FR-4: get_state RPC 握手最大重试次数。 */
const GET_STATE_MAX_RETRIES = 3;
/** FR-4: get_state RPC 握手重试间隔（ms）——单次超时后等待此间隔再重试。 */
const GET_STATE_RETRY_INTERVAL_MS = 500;
/** FR-4: get_state RPC 握手单次超时（ms）。 */
const GET_STATE_TIMEOUT_MS = 2000;

/** get_state 握手结果。 */
export interface GetStateResult {
  sessionFile?: string;
  sessionId?: string;
}

/**
 * FR-4: 通过 get_state RPC 查询子进程获取 sessionFile/sessionId。
 *
 * 当 stdout header 未获取到 sessionFile 时，尝试通过 get_state RPC 查询。
 * 最多重试 GET_STATE_MAX_RETRIES 次，单次超时 GET_STATE_TIMEOUT_MS 后等待
 * GET_STATE_RETRY_INTERVAL_MS 再发起下一次重试。
 *
 * @param child 子进程（stdin 写入 get_state 命令）
 * @param addResponseListener 注册 response 监听器的函数（stdout pump 中调用）
 * @returns 握手结果（可能为空——所有重试均超时/失败）
 */
export function performGetStateHandshake(
  child: ChildProcess,
  addResponseListener: (id: string, resolver: (data: unknown) => void) => void,
): Promise<GetStateResult> {
  return new Promise<GetStateResult>((resolve) => {
    const collected: GetStateResult = {};
    let attempts = 0;
    let resolved = false;

    function tryOnce(): void {
      if (resolved) return;
      attempts++;
      const reqId = sendGetStateCommand(child);

      const timer = setTimeout(() => {
        // 单次超时：等待间隔后重试，或放弃
        if (attempts < GET_STATE_MAX_RETRIES && !resolved) {
          // [Bug fix] 旧实现直接 tryOnce() 立即重试，GET_STATE_RETRY_INTERVAL_MS 声明却
          // 从未使用（eslint error 阻断 commit）。现在重试前等待间隔，让常量名与行为一致。
          const retry = setTimeout(() => tryOnce(), GET_STATE_RETRY_INTERVAL_MS);
          retry.unref();
        } else if (!resolved) {
          resolved = true;
          resolve(collected);
        }
      }, GET_STATE_TIMEOUT_MS);
      timer.unref();

      addResponseListener(reqId, (data: unknown) => {
        if (resolved) return;
        clearTimeout(timer);
        if (data && typeof data === "object") {
          const d = data as Record<string, unknown>;
          if (typeof d.sessionFile === "string" && d.sessionFile.length > 0) {
            collected.sessionFile = d.sessionFile;
          }
          if (typeof d.sessionId === "string" && d.sessionId.length > 0) {
            collected.sessionId = d.sessionId;
          }
        }
        // sessionFile 已获取——立即 resolve（无需更多重试）
        if (collected.sessionFile) {
          resolved = true;
          resolve(collected);
        }
        // 否则等待超时重试
      });
    }

    tryOnce();
  });
}
