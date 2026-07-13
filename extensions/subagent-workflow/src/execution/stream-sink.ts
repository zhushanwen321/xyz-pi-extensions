/**
 * [PoC] subagent text_delta streaming sink。
 *
 * background subagent 执行期间，session-runner 的 agentEvent 出口把每个 text_delta
 * 传到 SubagentStream.onDelta。本模块做 100ms 时间窗合并后，通过 StreamSink.setWidget
 * 转发到 RPC stdout（经 ctx.ui.setWidget → extension_ui_request 通道）。
 *
 * SubagentStream 是一个生命周期对象——内聚 buffer/timer 状态 + onDelta/dispose 方法。
 * 调用方（subagent-service）创建后只需在 text_delta 时调 onDelta、终态时调 dispose，
 * 不需要拆散 push/clear 两个函数跨层透传。
 *
 * 设计要点：
 * - leading edge：第一个 delta 立即 flush（前端尽快看到开始）
 * - trailing edge：后续 delta 追加 buffer，timer 到期后 flush
 * - 每次 flush 把 buffer 的累积全文 split("\n") 传给 setWidget
 * - dispose 清除 widget + 清 timer
 */

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。
 *
 * [hypothetical seam] 当前只有一个 adapter（ctx.ui.setWidget）。
 * 如果未来不出现第二个 sink 实现（如写文件 / 发 websocket），正式实现时应去掉此接口，
 * 直接用函数类型 `(key, lines) => void`。
 */
export interface StreamSink {
  setWidget(key: string, lines: string[] | undefined): void;
}

/** delta 合并窗口时间（ms）。与 onEventThrottled 的节流间隔对齐。 */
const STREAM_FLUSH_MS = 100;

/**
 * subagent text_delta streaming 生命周期对象。
 *
 * 创建后：
 * - `onDelta(delta)`：session-runner 每次 text_delta 调
 * - `dispose()`：subagent 终态时调，清除 widget + 清 timer
 *
 * buffer/timer 状态全部内聚在此对象，调用方不需要关心合并逻辑。
 */
export class SubagentStream {
  private readonly widgetKey: string;
  private readonly sink: StreamSink;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hasFlushed = false;
  private disposed = false;

  constructor(recordId: string, sink: StreamSink) {
    this.widgetKey = `subagent-stream-${recordId}`;
    this.sink = sink;
  }

  /** 接收一个 text_delta 增量。 */
  onDelta(delta: string): void {
    if (this.disposed) return;
    this.buffer += delta;
    if (!this.hasFlushed) {
      // leading edge：第一个 delta 立即 flush
      this.hasFlushed = true;
      this.flush();
    } else if (this.timer === undefined) {
      // trailing edge：后续 delta 经 timer 合并
      this.timer = setTimeout(() => this.flush(), STREAM_FLUSH_MS);
    }
  }

  /** 终态清理：清除 widget + 清 timer（幂等）。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.sink.setWidget(this.widgetKey, undefined);
  }

  private flush(): void {
    this.timer = undefined;
    if (this.buffer.length === 0 || this.disposed) return;
    this.sink.setWidget(this.widgetKey, this.buffer.split("\n"));
  }
}
