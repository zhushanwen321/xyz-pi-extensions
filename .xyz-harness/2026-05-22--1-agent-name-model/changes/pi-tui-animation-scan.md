# pi-tui Animation / Timer / Live-update Scan

## 1. Loader Component — Spinning Animation

**File**: `packages/tui/src/components/loader.ts`

```typescript
// Core pattern: setInterval + requestRender()
const DEFAULT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_INTERVAL_MS = 80;

private restartAnimation(): void {
  this.stop();
  if (this.frames.length <= 1) return;
  this.intervalId = setInterval(() => {
    this.currentFrame = (this.currentFrame + 1) % this.frames.length;
    this.updateDisplay();
  }, this.intervalMs);  // default 80ms
}

private updateDisplay(): void {
  const frame = this.frames[this.currentFrame] ?? "";
  const renderedFrame = this.renderIndicatorVerbatim ? frame : this.spinnerColorFn(frame);
  const indicator = frame.length > 0 ? `${renderedFrame} ` : "";
  this.setText(`${indicator}${this.messageColorFn(this.message)}`);
  if (this.ui) this.ui.requestRender();  // triggers differential render
}
```

**Key findings**:
- Loader **extends `Text`** component — uses `setText()` + `requestRender()` per frame
- Animation uses `setInterval` (not requestAnimationFrame or process.nextTick)
- `LoaderIndicatorOptions` supports custom frames and custom interval
- `setMessage()` allows changing label text mid-animation (live updates)
- `setIndicator()` resets frames and restarts animation
- An empty frames array hides the spinner entirely (text-only mode)

---

## 2. CancellableLoader

**File**: `packages/tui/src/components/cancellable-loader.ts`

```typescript
export class CancellableLoader extends Loader {
  private abortController = new AbortController();

  onAbort?: () => void;           // callback when user presses Escape
  get signal(): AbortSignal { }   // for async abort
  get aborted(): boolean { }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.cancel")) {
      this.abortController.abort();
      this.onAbort?.();
    }
  }

  dispose(): void { this.stop(); }
}
```

**Key findings**:
- Extends `Loader` — same animation mechanism, adds Escape-to-cancel
- `AbortSignal` for cancelling async operations, `onAbort` callback for UI cleanup
- `dispose()` stops interval timer

---

## 3. BorderedLoader (Interactive Mode Wrapper)

**File**: `packages/coding-agent/src/modes/interactive/components/bordered-loader.ts`

Wraps `CancellableLoader` (or `Loader`) with `DynamicBorder` + cancel key hint. Used for extension UI loaders.

```typescript
constructor(tui: TUI, theme: Theme, message: string, options?: { cancellable?: boolean }) {
  // ...
  this.loader = new CancellableLoader(tui,
    (s) => theme.fg("accent", s),
    (s) => theme.fg("muted", s),
    message,
  );
  // Wraps with DynamicBorder + spacer + cancel key hint + spacer + bottom border
}
```

---

## 4. Live Timer Pattern — `setInterval` + `context.invalidate()`

**File**: `packages/coding-agent/src/core/tools/bash.ts` (lines ~418–442)

This is **the canonical pattern** for a live-updating display in the TUI. The bash tool shows elapsed time that ticks up every second.

```typescript
// Inside renderResult — starts interval on first partial result:
renderResult(result, options, _theme, context) {
  const state = context.state;

  // START interval on first partial update
  if (state.startedAt !== undefined && options.isPartial && !state.interval) {
    state.interval = setInterval(() => context.invalidate(), 1000);
  }

  // STOP interval on completion
  if (!options.isPartial || context.isError) {
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
  }

  // Rebuild the component with new elapsed time
  const component = (context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
  rebuildBashResultRenderComponent(component, result, options, context.showImages, state.startedAt, state.endedAt);
  component.invalidate();
  return component;
}
```

The elapsed time display:
```typescript
if (startedAt !== undefined) {
  const label = options.isPartial ? "Elapsed" : "Took";
  const endTime = endedAt ?? Date.now();
  component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
}
```

**Key insight**: `context.invalidate()` is the mechanism for triggering a re-render. It clears any cached rendering state and calls `this.ui.requestRender()` internally (see `ToolRenderContext.invalidate` from the `getRenderContext` method in `tool-execution.ts`).

---

## 5. CountdownTimer — Reusable Timer Utility

**File**: `packages/coding-agent/src/modes/interactive/components/countdown-timer.ts`

Used for retry countdown and auto-dismiss dialogs.

```typescript
export class CountdownTimer {
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private remainingSeconds: number;

  constructor(
    timeoutMs: number,
    private tui: TUI | undefined,
    private onTick: (seconds: number) => void,
    private onExpire: () => void,
  ) {
    this.remainingSeconds = Math.ceil(timeoutMs / 1000);
    this.onTick(this.remainingSeconds);  // initial tick
    this.intervalId = setInterval(() => {
      this.remainingSeconds--;
      this.onTick(this.remainingSeconds);
      this.tui?.requestRender();         // trigger re-render each tick
      if (this.remainingSeconds <= 0) {
        this.dispose();
        this.onExpire();
      }
    }, 1000);
  }

  dispose(): void { clearInterval(this.intervalId); }
}
```

**Usage in interactive-mode.ts** (retry pattern with Loader + CountdownTimer):
```typescript
case "auto_retry_start": {
  this.retryLoader = new Loader(this.ui, /* ... */);
  this.retryCountdown = new CountdownTimer(
    event.delayMs,
    this.ui,
    (seconds) => {
      this.retryLoader?.setMessage(retryMessage(seconds));  // live update
    },
    () => { /* cleanup */ },
  );
  this.statusContainer.addChild(this.retryLoader);
  break;
}
```

---

## 6. Stream Output Pattern — `onUpdate` in tool execute()

**File**: `packages/coding-agent/src/core/tools/bash.ts` (lines ~290–370)

The `onUpdate` callback (type `AgentToolUpdateCallback`) is called repeatedly during long-running tool execution to stream partial results to the UI.

```typescript
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

// bash tool example:
async execute(_toolCallId, params, signal, onUpdate, _ctx) {
  // Initial empty update to signal "tool started"
  if (onUpdate) onUpdate({ content: [], details: undefined });

  return new Promise((resolve, reject) => {
    ops.exec(command, cwd, {
      onData: (data: Buffer) => {
        // Accumulate output...
        if (onUpdate) {
          onUpdate({
            content: [{ type: "text", text: truncation.content || "" }],
            details: { truncation, fullOutputPath },
          });
        }
      },
    });
  });
}
```

The interactive mode listens to these update events:

```typescript
// interactive-mode.ts
case "tool_execution_start": {
  // Creates ToolExecutionComponent, adds to chatContainer
}
case "tool_execution_update": {
  component.updateResult({ ...event.partialResult, isError: true }, true);  // isPartial=true
  this.ui.requestRender();
}
case "tool_execution_end": {
  component.updateResult({ ...event.result, isError: event.isError });  // isPartial=false
  this.pendingTools.delete(event.toolCallId);
  this.ui.requestRender();
}
```

---

## 7. Subagent Extension — Parallel onUpdate Pattern

**File**: `packages/coding-agent/examples/extensions/subagent/index.ts` (lines ~515–593)

The subagent tool uses `onUpdate` to stream per-task results during parallel execution:

```typescript
const emitParallelUpdate = () => {
  if (onUpdate) {
    const running = allResults.filter((r) => r.exitCode === -1).length;
    const done = allResults.filter((r) => r.exitCode !== -1).length;
    onUpdate({
      content: [{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${running} running...` }],
      details: makeDetails("parallel")([...allResults]),
    });
  }
};
```

---

## 8. TUI Rendering Cycle — How re-renders work

**File**: `packages/tui/src/tui.ts`

```
requestRender() → process.nextTick → scheduleRender()
  → setTimeout(MIN_RENDER_INTERVAL_MS=16ms) → doRender()

doRender():
  1. this.render(width) — calls all children's render()
  2. compositeOverlays() — render overlays on top
  3. Extract cursor position
  4. Differential comparison (previousLines vs newLines)
  5. Write only changed lines to terminal via synchronized output
```

**Lifecycle for a live-updating component** (e.g., bash elapsed timer):

1. Tool's `execute()` calls `onUpdate(partialResult)` with streaming output
2. Interactive mode catches `tool_execution_update` event
3. Calls `component.updateResult(partialResult, true)` on ToolExecutionComponent
4. ToolExecutionComponent calls `renderResult()` which returns a component with live timer
5. Timer uses `setInterval(() => context.invalidate(), 1000)`
6. `context.invalidate()` → `this.ui.requestRender()` → `doRender()` → differential render

---

## 9. The `renderCall` / `renderResult` / `context.invalidate` Pipeline

**File**: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`

```typescript
private getRenderContext(lastComponent): ToolRenderContext {
  return {
    invalidate: () => {
      this.invalidate();
      this.ui.requestRender();   // <-- re-renders just this tool row
    },
    state: this.rendererState,   // <-- shared mutable state
    lastComponent,                // <-- reuse existing DOM-like reference
    isPartial: this.isPartial,   // <-- controls live/streaming vs final
    // ...
  };
}
```

**Pattern for live-updating renderers**:
1. Store mutable state in `context.state` (e.g., `startedAt`, `interval`)
2. On first partial result, start a timer that calls `context.invalidate()`
3. On every invalidation, the renderer is called again with updated `context.state`
4. Reuse `context.lastComponent` if it's the same type — no re-creation needed
5. On completion, clear the timer and set final values

---

## Summary Table

| Pattern | Mechanism | Files | Use Case |
|---------|-----------|-------|----------|
| Spinner animation | `setInterval` (80ms) + `requestRender()` | `loader.ts` | Loading indicators |
| Live elapsed timer | `setInterval` (1000ms) + `context.invalidate()` | `bash.ts` lines 418-442 | Showing "Elapsed X.Xs" |
| Countdown timer | `setInterval` (1000ms) + callback + `requestRender()` | `countdown-timer.ts` | Retry countdown, auto-dismiss |
| Stream output | `onUpdate(partialResult)` → tool_execution_update → `updateResult()` | `bash.ts`, `tool-execution.ts` | Live output streaming |
| Parallel progress | `onUpdate()` with aggregated results | `subagent/index.ts` | Multi-agent progress |
| Message-only update | `Loader.setMessage()` (no interval change) | `loader.ts` | Changing label during loading |
| Custom animation frames | `LoaderIndicatorOptions.frames` | `loader.ts` | Custom spinners, pulse dots |

**Answers to key questions:**

- **Does Loader support custom content?** Yes — `setMessage(text)` for text; `LoaderIndicatorOptions.frames` for custom spinner frames; empty frames for text-only mode.
- **Animation mechanism?** `setInterval` with `DEFAULT_INTERVAL_MS=80ms`. Updates via `this.setText()` + `requestRender()`.
- **Live timer pattern?** Use `setInterval(() => context.invalidate(), 1000)` inside `renderResult`, store state in `context.state`. Clear interval on completion.
- **Re-render cycle?** `requestRender()` coalesces via `process.nextTick` + `setTimeout(16ms)`, then `doRender()` does differential comparison of rendered lines. `renderResult` is called repeatedly on each invalidation. `onUpdate` is the streaming mechanism; `renderResult` + `context.invalidate()` is the re-render mechanism.
