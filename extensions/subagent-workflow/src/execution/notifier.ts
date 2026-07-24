// src/execution/notifier.ts
//
// Background 完成回注主对话。sync 不用（调用方还在 await，结果直接返回）。
//
// 职责：
//   - 合并窗口：MERGE_WINDOW_MS 内多个完成合并为一条通知
//   - 去重 TTL：同 id 在 TTL 内不重复通知
//   - 通过 pi.sendMessage({ deliverAs:"followUp", triggerTurn:true }) 注入——
//     当前 turn 结束后唤醒父 agent 处理结果（followUp 不打断 streaming、不锁滚动）

/** 一条待发送的完成通知记录。 */
export interface BgNotifyRecord {
  id: string;
  status: "done" | "failed" | "cancelled";
  agent: string;
  /** 执行所用 model（RecordSnapshot.model），用于完成通知显示。 */
  model?: string;
  result?: string;
  error?: string;
  startedAt: number;
  endedAt: number | undefined;
  /** [MF#1] fork+worktree 模式下子 agent 改动的 patch 路径（worktree 外，cleanup 后留存）。
   *  done 时通知文本显式提示 `git apply`，否则 background 子 agent 在隔离 worktree 的改动
   *  会静默丢失——父 LLM 不知 patch 路径，无法应用。 */
  patchFile?: string;
}

/** notifier 依赖的 pi 最小接口（解耦，便于测试）。 */
export interface NotifierHost {
  /** 注入消息到主对话。
   *  triggerTurn:true + deliverAs:"steer" → 空闲时立即 prompt 新 turn；streaming 时
   *  进 steer 队列等下个 turn 边界 drain。
   *
   *  ⚠️ 竞态注意：triggerTurn 分支只在主 agent isStreaming===false 时生效。若调用时
   *  主 agent 处于 agent_end → finishRun 的窄窗口（isStreaming 仍 true），消息会被
   *  错误走 steer 分支入队，而 runLoop 已结束无人 drain → 通知静默丢失。flushPendingNotifications
   *  通过 isIdle() 退避保证在 idle 后同步送达，规避此窗口。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
  /** 是否还有 running 的 background 任务（用于滑动窗口立即 flush 判断）。 */
  hasRunningBackground(): boolean;
  /** 主 agent 是否空闲（非 streaming）。flush 前 gate 用——避免在 agent_end→finishRun
   *  竞态窗口里 sendMessage 走错分支（steer 入队无人 drain）。
   *  可选：未注入（旧测试 host）时 flush 不 gate，保持原行为。 */
  isIdle?: () => boolean;
}

/** 合并窗口（ms）。窗口内多个完成合并为一条消息。 */
const MERGE_WINDOW_MS = 60_000;
/** 去重 TTL（ms）。同 id 在此窗口内不重复通知。 */
const DEDUP_TTL_MS = 60_000;
/** [竞态修复] flush 时若主 agent 仍 streaming，短退避重试间隔（ms）。
 *  场景：subagent 完成的 detached microtask 与主 agent agent_end→finishRun 竞态，
 *  isIdle()=false 时退避，等 idle 后再 sendMessage(triggerTurn)，避免走 steer 分支丢失。 */
const FLUSH_BACKOFF_MS = 100;
/** [竞态修复] flush 退避上限次数。防止主 agent 永久 busy 时无限重试——
 *  达上限后强制发送（fallthrough 到 pi 的 steer/triggerTurn 分支，至少不丢消息）。 */
const FLUSH_BACKOFF_MAX = 50; // 50 × 100ms = 5s

/** 发送给主对话的 customType（bg-notify-render 消费）。 */
const NOTIFY_CUSTOM_TYPE = "subagent-bg-notify";

/**
 * Background 完成通知器（滑动窗口合并）。
 *
 *   notify(record):
 *     1. dedup TTL 检查：同 id 在 TTL 内 → 跳过
 *     2. 入 pending 队列
 *     3. 清除旧 timer（滑动窗口重置）
 *     4. 已无 running background → 立即 flush（最后一批）
 *     5. 否则重启 MERGE_WINDOW_MS timer（等后续完成合并）
 *
 *   flushPendingNotifications():  timer 到期 / 无 running / shutdown 触发
 *     1. isIdle gate：主 agent 仍 streaming → 退避重试（scheduleFlush），等 idle 后再发
 *     2. doSend：取出 pending 全部 record
 *     3. 合并为一条消息（多条时列 bullet list）
 *     4. sendMessage({ customType:"subagent-bg-notify",
 *                     content, display:true,
 *                     triggerTurn:true, deliverAs:"steer" })
 *     5. 清空 pending + timer
 *
 * 滑动窗口：每次有新完成都重置 60s 计时器，密集完成的任务尽量合并到一条通知。
 * 无 running 时立即 flush——避免最后一条等满窗口。
 */
export class BgNotifier {
  private readonly pending: BgNotifyRecord[] = [];
  /** dedup：id → 上次通知时间戳。 */
  private readonly dedup = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private _disposed = false;
  /** flush 重试计数（isIdle gate 退避用）。每次成功发送后清零。 */
  private flushAttempts = 0;

  constructor(private readonly host: NotifierHost) {}

  /**
   * 入队一条完成通知（去重 + 滑动窗口合并）。dispose 后短路。
   */
  notify(record: BgNotifyRecord): void {
    if (this._disposed) return;

    const now = Date.now();
    // sweep 过期 dedup 条目（防 Map 无限增长）
    if (this.dedup.size > 0) {
      for (const [id, ts] of this.dedup) {
        if (now - ts >= DEDUP_TTL_MS) this.dedup.delete(id);
      }
    }
    const lastSeen = this.dedup.get(record.id);
    if (lastSeen !== undefined && now - lastSeen < DEDUP_TTL_MS) return;
    this.dedup.set(record.id, now);

    this.pending.push(record);

    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }

    if (!this.host.hasRunningBackground()) {
      this.flushPendingNotifications();
      return;
    }

    this.timer = setTimeout(() => this.flushPendingNotifications(), MERGE_WINDOW_MS);
  }

  /** 立即 flush（session_shutdown 调用，防丢失）。
   *  外部入口（notify 立即触发 / shutdown）。内部实际发送在 doSend 中，
   *  外部入口不传 attempt，走 isIdle gate 退避逻辑。 */
  flushPendingNotifications(): void {
    this.scheduleFlush(0);
  }

  /**
   * [竞态修复] 调度 flush：isIdle gate + 退避重试。
   *
   * 核心问题：sendMessage({triggerTurn:true}) 只在主 agent isStreaming===false 时
   * 启动新 turn。若 flush 在 agent_end → finishRun 的窄窗口触发（isStreaming 仍 true），
   * 消息走 steer 分支入队，runLoop 已结束无人 drain → 通知丢失（非必现，时序竞态）。
   *
   * 修复：isIdle() 可用时，busy 退避到 idle 后再发送。isIdle() 与 sendMessage 同步链
   * （均读 agent.state.isStreaming，host.sendMessage 不 await），故一旦 isIdle=true，
   * 同步调 sendMessage 必走 triggerTurn 分支。isIdle 未注入（旧 host）时不 gate，原行为。
   *
   * 退避上限：FLUSH_BACKOFF_MAX 次后强制发送——防主 agent 永久 busy（长 turn）时通知饿死，
   * fallthrough 到 pi 的 steer/triggerTurn 分支，至少不丢消息（busy 时走 steer 会在该
   * turn 结束后由 _handlePostAgentRun drain）。
   */
  private scheduleFlush(attempt: number): void {
    if (this._disposed) return;
    if (this.pending.length === 0) return;

    // isIdle gate：注入了 isIdle 且当前 busy → 退避重试（未达上限）
    if (this.host.isIdle) {
      let idle = true;
      try {
        idle = this.host.isIdle();
      } catch {
        // isIdle 内部 assertActive 可能抛（session 已关闭）——视为不可发送，丢弃。
        // dispose 后本函数首行已短路，此处 catch 兜底极端时序。
        this.pending.length = 0;
        this.flushAttempts = 0;
        return;
      }
      if (!idle && attempt < FLUSH_BACKOFF_MAX) {
        this.timer = setTimeout(() => this.scheduleFlush(attempt + 1), FLUSH_BACKOFF_MS);
        return;
      }
      // idle 或达上限 → 继续发送
    }

    this.doSend();
  }

  /** 实际发送（取出 pending + 合并 + sendMessage）。清 timer + 重试计数。 */
  private doSend(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.pending.length === 0) return;
    this.flushAttempts = 0;

    const records = this.pending.splice(0);
    const content = records.length === 1
      ? this.buildLlmContent(records[0])
      : records.map((r) => this.buildLlmContent(r)).join("\n\n---\n\n");
    const details = records.length === 1
      ? records[0]
      : { batch: true, items: records };

    this.host.sendMessage({
      customType: NOTIFY_CUSTOM_TYPE,
      content,
      display: true,
      details,
      // [W2 修复] followUp → steer：subagent 完成通知需立即抢占主 agent 下一个 turn，
      // 即使主 agent 处于轮询 subagent_list 的 processing 状态（followUp 永远排不上）。
      // 与 workflow helpers.ts:151 同语义对齐（commit d214d0d83 验证 steer 能避免
      // 'Agent is already processing' 错误）。
      // [竞态修复] 配合 scheduleFlush 的 isIdle gate：此时主 agent 已确认 idle，
      // triggerTurn 必走 _runAgentPrompt 启动新 turn，不会撞 steer 分支丢失。
    }, { triggerTurn: true, deliverAs: "steer" });
  }

  private buildLlmContent(record: BgNotifyRecord): string {
    const agent = record.agent;
    const id = record.id;
    switch (record.status) {
      case "done": {
        const base = `Subagent "${agent}" (${id}) completed. Result:\n${record.result ?? "(empty)"}`;
        if (record.patchFile) {
          return `${base}\n\nThis subagent ran in an isolated worktree; its file changes were captured as a patch:\n  ${record.patchFile}\nTo bring these changes into the current repo, run: \`git apply ${record.patchFile}\``;
        }
        return base;
      }
      case "failed":
        return `Subagent "${agent}" (${id}) failed: ${record.error ?? "(unknown error)"}`;
      case "cancelled":
        return `Subagent "${agent}" (${id}) cancelled.`;
    }
  }

  /** session 结束：清 timer，丢弃 pending。 */
  dispose(): void {
    this._disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pending.length = 0;
    this.dedup.clear();
    this.flushAttempts = 0;
  }

  /** /resume /fork /new 后复活。 */
  revive(): void {
    this._disposed = false;
  }
}
