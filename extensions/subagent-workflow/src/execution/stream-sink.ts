/**
 * [PoC] subagent text_delta streaming sink。
 *
 * background subagent 执行期间，session-runner 的 onStreamDelta 回调把每个 text_delta
 * 传到这里。本模块做 100ms 时间窗合并后，通过 StreamSink.setWidget 转发到 RPC stdout
 * （经 ctx.ui.setWidget → extension_ui_request 通道）。
 *
 * 设计要点：
 * - leading edge：第一个 delta 立即 flush（前端尽快看到开始）
 * - trailing edge：后续 delta 追加 buffer，timer 到期后 flush
 * - 每次 flush 把 buffer 的累积全文 split("\n") 传给 setWidget
 * - subagent 终态时调 clear 清除 widget
 */

/** UI streaming sink 的最小接口（ctx.ui.setWidget 的 duck-typed 子集）。 */
export interface StreamSink {
  setWidget(key: string, lines: string[] | undefined): void;
}

/** delta 合并窗口时间（ms）。与 onEventThrottled 的节流间隔对齐。 */
const STREAM_FLUSH_MS = 100;

/**
 * 创建 text_delta 合并 sink——绑定到特定 recordId。
 *
 * 返回两个函数：
 * - push(delta)：session-runner 每次 text_delta 调
 * - clear()：subagent 终态时调，清除 widget
 */
export function createStreamDeltaSink(
  recordId: string,
  sink: StreamSink,
): {
  push: (delta: string) => void;
  clear: () => void;
} {
  const widgetKey = `subagent-stream-${recordId}`;
  let buffer = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hasFlushed = false;

  const flush = (): void => {
    timer = undefined;
    if (buffer.length === 0) return;
    sink.setWidget(widgetKey, buffer.split("\n"));
  };

  const push = (delta: string): void => {
    buffer += delta;
    if (!hasFlushed) {
      // leading edge：第一个 delta 立即 flush
      hasFlushed = true;
      flush();
    } else if (timer === undefined) {
      // trailing edge：后续 delta 经 timer 合并
      timer = setTimeout(flush, STREAM_FLUSH_MS);
    }
  };

  const clear = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    sink.setWidget(widgetKey, undefined);
  };

  return { push, clear };
}
