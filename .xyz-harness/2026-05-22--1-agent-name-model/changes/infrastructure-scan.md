# Subagent Extension Infrastructure Scan

## 1. Project Structure

```
subagent/
  index.ts              # Re-export facade: `export { default } from "./src/index.ts"`
  package.json          # name: pi-extension-subagent, main: src/index.ts
  src/
    index.ts            # Extension entry point. Registers `subagent` + `collect_subagent` tools.
                        # Mode dispatch (single/parallel/chain/background), parameter schemas (typebox),
                        # renderCall/renderResult wiring. ~350 lines.
    spawn.ts            # Process spawning, background job lifecycle, temp file management.
                        # Factory pattern: createSpawnManager(pi) returns session-scoped SpawnManager.
                        # ~450 lines.
    render.ts           # View models, TUI rendering, formatting helpers.
                        # Types (SingleResult, SubagentDetails, AgentResultView, ParallelSummaryView).
                        # renderAgentDetail, renderParallelTable, renderChainCollapsedText, etc.
                        # ~450 lines.
    model.ts            # Model resolution: taskComplexity routing, explicit model ref, fallback chain.
                        # Reads ~/.pi/agent/subagent-models.json. ~250 lines.
    agents.ts           # Agent discovery from .md frontmatter files (user + project dirs).
                        # discoverAgents(), AgentConfig type. ~120 lines.
```

## 2. Exported APIs

### index.ts
| Export | Type | Purpose |
|--------|------|---------|
| `default` | `(pi: ExtensionAPI) => void` | Extension factory. Registers tools + `session_shutdown` handler. |

### spawn.ts
| Export | Type | Purpose |
|--------|------|---------|
| `createSpawnManager` | `(pi: ExtensionAPI) => SpawnManager` | Session-scoped factory. All mutable state (jobs Map, sessionJobFiles Set, jobEvents EventEmitter) lives in closure. |
| `mapWithConcurrencyLimit` | `<TIn,TOut>(items[], n, fn) => Promise<TOut[]>` | Worker-pool pattern for parallel execution. |
| `ThrottleState` | `class` | Rate-limits `onUpdate` calls. `shouldEmit()` / `forceEmit()`. |
| `cleanupOldTempFiles` | `() => void` | Deletes temp prompt files older than 1 hour from `os.tmpdir()/pi-subagent/`. |
| `parseOutputFileSmall` | `(path, result) => ParsedJobResult` | Sync JSONL parser for background job output files. |
| `MAX_PARALLEL_TASKS` | `8` | Hard cap on parallel task count. |
| `MAX_CONCURRENCY` | `4` | Worker pool size for parallel execution. |

**SpawnManager interface:**
| Method | Purpose |
|--------|---------|
| `runSingleAgent(...)` | Spawn a pi child process in `--mode json`, stream JSONL stdout, build SingleResult. |
| `startBackgroundJob(...)` | Spawn detached process, write stdout to temp JSONL file, auto-inject result via `pi.sendMessage()`. |
| `cleanupJob(job)` | Kill process, emit done event, delete temp files. |
| `cleanupAllJobs()` | Cleanup all active jobs on session shutdown. |
| `getActiveJobs()` | Returns `Map<string, JobInfo>` of running background jobs. |
| `getJobEvents()` | Returns `EventEmitter` for `done:{jobId}` events. |
| `getSessionJobFiles()` | Returns `Set<string>` of temp file paths for this session. |

### model.ts
| Export | Type | Purpose |
|--------|------|---------|
| `resolveModel` | `(ref, ctx) => Promise<Result>` | Validate `"provider/model"` against scoped model registry. Falls back to subagent-models.json fallbacks. |
| `resolveModelByComplexity` | `(complexity, ctx) => Promise<Result>` | Auto-route: load config, filter by complexity, sort by `order`, try each candidate. |
| `loadSubagentModels` | `() => Config \| null` | Lazy singleton cache of `~/.pi/agent/subagent-models.json`. |
| `buildModelsHintFromConfig` | `() => string` | Human-readable model summary for tool description (sync). |
| `buildModelsHintDynamic` | `(ctx) => Promise<string>` | Three-tier fallback hint for error messages. |
| `COMPLEXITY_DEFAULT_THINKING` | `Record<TaskComplexity, ThinkingLevel>` | `{ low: "high", medium: "high", high: "max" }` |
| `THINKING_TO_PI` | `Record<ThinkingLevel, string>` | `{ high: "high", max: "xhigh" }` — maps to Pi CLI `--thinking` flag. |

### agents.ts
| Export | Type | Purpose |
|--------|------|---------|
| `discoverAgents` | `(cwd, scope) => AgentDiscoveryResult` | Scan user agents dir (`~/.pi/agent/agents/`) + nearest project `.pi/agents/`. |
| `loadAgentsFromDir` | `(dir, source) => AgentConfig[]` | Parse `.md` files with YAML frontmatter (`name`, `description`, `tools`). Body = systemPrompt. |
| `formatAgentList` | `(agents, max) => {text, remaining}` | Truncated agent listing for error messages. |

### render.ts
| Export | Type | Purpose |
|--------|------|---------|
| **Types** | | |
| `UsageStats` | `interface` | `{ input, output, cacheRead, cacheWrite, cost, contextTokens, turns }` |
| `SingleResult` | `interface` | Raw result from one agent execution. Has `messages: Message[]`, `exitCode`, `usage`, `durationMs`, etc. |
| `SubagentDetails` | `interface` | `details` field of tool result. `{ mode, resolvedModel, agentScope, results: SingleResult[] }`. |
| `AgentResultView` | `interface` | View model for one agent. `{ name, source, status, duration, turns, tokens, cost, toolCalls, finalOutput, ... }`. |
| `ParallelSummaryView` | `interface` | Aggregate view. `{ total, succeeded, failed, running, isDone, agents, aggregateTokens, aggregateCost }`. |
| `DisplayItem` | `type` | Discriminated union: `{ type: "text", text }` \| `{ type: "toolCall", name, args }`. |
| **Builders** | | |
| `buildAgentResultView` | `(SingleResult) => AgentResultView` | Maps raw result → view model. Derives `status` from `exitCode`. |
| `buildParallelSummaryView` | `(SingleResult[]) => ParallelSummaryView` | Aggregates multiple results. Computes totals, determines `isDone`. |
| **Renderers** | | |
| `renderAgentDetail` | `(view, theme, mdTheme, opts) => Container` | Expanded view for one agent: icon + header + task + output + usage. Uses Container/Text/Spacer/Markdown. |
| `renderSingleCollapsedText` | `(view, theme) => string` | Collapsed single-agent view. Returns raw string with ANSI codes. Shows last 10 tool calls. |
| `renderChainCollapsedText` | `(views, details, icon, theme) => Text` | Collapsed chain view. Steps with icon, last 5 items each. |
| `renderParallelTable` | `(view, theme) => Text` | Collapsed parallel view. Table format: agent name, status, duration, tokens, cost. |
| `renderParallelDetail` | `(view, theme, mdTheme) => Container` | Expanded parallel view. Full detail for each agent. |
| **Helpers** | | |
| `formatTokens` | `(n) => string` | `123` / `1.2k` / `45k` / `1.3M` |
| `formatDuration` | `(ms) => string` | `450ms` / `3.2s` / `2m15s` |
| `formatUsageStats` | `(usage, model?) => string` | Compact stat line: `3 turns ↑12k ↓2k R8k W1k $0.0234 ctx:50k model` |
| `formatToolCall` | `(name, args, themeFg) => string` | Tool-specific formatting for bash/read/write/edit/ls/find/grep. |
| `formatTimestamp` | `(epochMs) => string` | `HH:MM:SS` |
| `getDisplayItems` | `(messages) => DisplayItem[]` | Extract text + toolCall items from Message[]. |
| `getFinalOutput` | `(messages) => string` | Last non-empty assistant text from messages (reversed scan). |
| `aggregateUsageFromViews` | `(views) => string` | Sum turns/tokens/cost, format. |
| `COLLAPSED_ITEM_COUNT` | `10` | Max tool calls shown in collapsed view. |

## 3. Type Definitions (Rendering Pipeline)

### Data Flow
```
execute() → SingleResult[] → SubagentDetails (via makeDetails closure)
    → buildAgentResultView() / buildParallelSummaryView()
    → renderResult(details, { expanded }) → Text | Container
```

### Key Types

```typescript
// Raw execution output — produced by spawn.ts
interface SingleResult {
  agent: string;
  agentSource: "user" | "project" | "unknown";
  task: string;
  exitCode: number;          // -1 = running, 0 = success, else failed
  messages: Message[];        // Full JSONL messages from pi child process
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;              // Chain step number (1-based)
  startTime: number;          // epoch ms
  endTime?: number;
  durationMs?: number;
  lastActivityTime: number;
}

// Stored in tool result `.details` — consumed by renderResult
interface SubagentDetails {
  mode: "single" | "parallel" | "chain" | "background";
  resolvedModel: string;
  agentScope: AgentScope;
  projectAgentsDir: string | null;
  results: SingleResult[];
}

// View model — derived from SingleResult, used by all render functions
interface AgentResultView {
  name: string;
  source: string;
  status: "running" | "succeeded" | "failed";
  duration: DurationInfo;
  turns: number;
  tokens: { input: number; output: number };
  cost: number;
  model?: string;
  task: string;
  toolCalls: DisplayItem[];
  finalOutput: string;
  errorMessage?: string;
  stopReason?: string;
}

// Aggregate view for parallel mode
interface ParallelSummaryView {
  total: number;
  succeeded: number;
  failed: number;
  running: number;
  isDone: boolean;
  agents: AgentResultView[];
  aggregateTokens: { input: number; output: number };
  aggregateCost: number;
  totalDurationMs?: number;    // max of all agent durations (wall clock)
}
```

## 4. Patterns

### renderCall Pattern
- **Input**: `args` (raw tool parameters), `theme`, `_context`
- **Output**: `new Text(annotatedString, 0, 0)`
- Displays: mode label, agent names, task preview (truncated), model, scope, background flag
- Uses `theme.fg()` for all coloring — no hardcoded ANSI

### renderResult Pattern
- **Input**: `result` (has `.content[]` and `.details`), `{ expanded }` (boolean from Ctrl+O), `theme`, `_context`
- **Output**: `Text | Container`
- Logic:
  1. Cast `result.details` to `SubagentDetails`
  2. If no details/results → plain text from content
  3. Branch on `details.mode`:
     - **single**: `expanded ? renderAgentDetail() : renderSingleCollapsedText()`
     - **chain**: `expanded ? Container with per-step detail : renderChainCollapsedText()`
     - **parallel**: `expanded && isDone ? renderParallelDetail() : renderParallelTable()`
  4. Background mode returns plain text (job ID message)

### onUpdate Live Update Pattern
- `execute()` receives `onUpdate: (partial: AgentToolResult<SubagentDetails>) => void`
- **Single mode**: onUpdate called directly from spawn.ts `emitUpdate()` on each JSONL `message_end` / `tool_result_end` event
- **Parallel mode**: `ThrottleState(500ms)` rate-limits updates. Each task's onUpdate writes into `allResults[index]`, then `emitParallelUpdate()` fires if throttle allows. `forceEmit()` after each task completes.
- **Chain mode**: Each step wraps onUpdate to accumulate previous results and emit with `makeDetails("chain")(allResults)`
- **Background mode**: No onUpdate — returns immediately with job ID

### ThrottleState
```typescript
class ThrottleState {
  private lastEmitTime = 0;
  constructor(intervalMs = 500) { ... }
  shouldEmit(): boolean   // true if 500ms since last emit
  forceEmit(): void       // reset lastEmitTime to 0, forcing next shouldEmit() = true
}
```

### Background Job Lifecycle
1. `startBackgroundJob()` → spawn detached process, write stdout to `tmpdir()/pi-subagent-jobs/{jobId}.out`
2. JSONL parsed incrementally via `processStdoutChunk` → `parseResult` updated in real-time
3. On process exit → `injectBackgroundResult()` called:
   - Builds summary string (agent, model, usage, output preview)
   - Calls `pi.sendMessage({ customType: "subagent-background-result", ... }, { deliverAs: "followUp", triggerTurn: true })`
   - Removes job from active map
4. `collect_subagent` tool can poll/list jobs. Uses `done:{jobId}` event + 10s poll interval.

### Process Spawning
- Uses `child_process.spawn()` with `--mode json -p --no-session`
- System prompt written to temp file, passed via `--append-system-prompt`
- `getPiInvocation()` resolves correct binary (handles Bun vs Node vs pi)
- AbortSignal support: SIGTERM → 5s grace → SIGKILL

## 5. Dependencies

### Runtime (provided by Pi)
| Package | Usage |
|---------|-------|
| `@mariozechner/pi-tui` | `Text`, `Container`, `Spacer`, `Markdown`, `MarkdownTheme` |
| `@mariozechner/pi-coding-agent` | `ExtensionAPI`, `Theme`, `getMarkdownTheme`, `StringEnum` (from pi-ai re-export), `getAgentDir`, `parseFrontmatter`, `withFileMutationQueue` |
| `@mariozechner/pi-ai` | `Message` type, `StringEnum` |
| `typebox` | `Type.Object()`, `Type.String()`, `Type.Array()`, `Type.Optional()`, `Type.Boolean()` for parameter schemas |
| Node built-ins | `child_process`, `fs`, `os`, `path`, `crypto`, `events` |

### pi-tui Components Used
| Component | Usage in subagent |
|-----------|------------------|
| `Text` | Primary rendering unit. `new Text(ansiString, 0, 0)`. Both collapsed and header rendering. |
| `Container` | Expanded views. `addChild()` chains Text + Spacer + Markdown. |
| `Spacer` | Visual separation. `new Spacer(1)` = 1 empty line. |
| `Markdown` | Agent final output rendering. `new Markdown(text, 0, 0, mdTheme)`. |

## 6. pi-tui API Reference

### Component Interface
```typescript
interface Component {
  render(width: number): string[];  // Render to ANSI lines at given viewport width
  handleInput?(data: string): void; // Keyboard input when focused
  invalidate(): void;               // Clear cached rendering state
}
```

### Available Components
| Component | Constructor | Purpose |
|-----------|------------|---------|
| `Text` | `new Text(text?, paddingX?, paddingY?, customBgFn?)` | Multi-line text with word wrapping. Core rendering primitive. |
| `Container` | `new Container()` | Layout container. `addChild(Component)`, `removeChild()`, `clear()`. Sequential vertical layout. |
| `Spacer` | `new Spacer(lines?)` | Empty lines separator. Default 1 line. |
| `Markdown` | `new Markdown(text, paddingX, paddingY, theme, defaultTextStyle?)` | Markdown → ANSI rendering. Handles headings, code blocks, tables, lists. |
| `Box` | — | Bordered box container |
| `Image` | `new Image(options)` | Terminal image rendering (Kitty/iTerm2/Sixel) |
| `Input` | `new Input()` | Text input field |
| `Editor` | `new Editor(options)` | Multi-line editor |
| `SelectList` | `new SelectList(layout, theme)` | Scrollable selectable list |
| `SettingsList` | `new SettingsList(theme)` | Settings-style list |
| `TruncatedText` | `new TruncatedText()` | Text that truncates with ellipsis |
| `Loader` | `new Loader(options?)` | Animated loading indicator |
| `CancellableLoader` | `new CancellableLoader()` | Loader with cancel support |

### Layout Model
- All components are **vertically stacked**. Container renders children in order.
- `render(width)` returns `string[]` (one string per terminal line, with ANSI codes).
- Width is propagated from parent to children.

### Theme System
```typescript
// Theme color tokens (semantic)
type ThemeColor = "accent" | "border" | "success" | "error" | "warning"
  | "muted" | "dim" | "text" | "toolTitle" | "toolOutput"
  | "mdHeading" | "mdCode" | "mdCodeBlock" | "mdQuote" ...
type ThemeBg = "selectedBg" | "userMessageBg" | "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"

class Theme {
  fg(color: ThemeColor, text: string): string   // Apply foreground color
  bg(color: ThemeBg, text: string): string       // Apply background color
  bold(text: string): string
  italic(text: string): string
  // ...
}

// Markdown theme — obtained via getMarkdownTheme() from pi-coding-agent
interface MarkdownTheme {
  heading, link, code, codeBlock, quote, listBullet, bold, italic, ...
}
```

### Subagent Theme Token Usage
| Token | Where used |
|-------|-----------|
| `success` | Checkmark icons for succeeded agents |
| `error` | X icons, error messages, failed status |
| `warning` | Running/pending status, background flag |
| `toolTitle` | "subagent" label, agent names in headers |
| `accent` | Agent names, chain/parallel labels, file paths |
| `muted` | Section headers ("─── Output ───"), dim info, "(Ctrl+O to expand)" |
| `dim` | Duration, model name, usage stats, path shortening |
| `toolOutput` | Bash command preview, text output preview |

### Update/Render Lifecycle
1. Extension registers `renderCall(args, theme)` — called when tool invocation starts
2. Extension registers `execute(id, params, signal, onUpdate, ctx)` — runs the work
3. During execution, `onUpdate({ content, details })` may be called to update live display
4. `execute()` returns `{ content, details, isError? }`
5. Extension registers `renderResult(result, options, theme)` — called with final or expanded view
6. `options.expanded` toggles collapsed (Text with ANSI) vs expanded (Container with Markdown)
