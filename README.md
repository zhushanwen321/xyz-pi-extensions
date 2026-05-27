# xyz-pi-extensions

Collection of custom extensions for [Pi coding agent](https://github.com/badlogic/pi-mono).

## Extensions

### [goal](./goal/)

Codex-style `/goal` command — persistent goal-driven autonomous loop with evidence-based completion, token/time budgets, blocked detection, and steering templates.

```bash
/goal Fix all failing tests --tokens 500000 --timeout 30
```

### [workflow](./workflow/)

Multi-agent orchestration engine — write JS scripts to define agent pipelines, run them via `/workflow run` or the `workflow-run` tool. Supports `agent()`, `parallel()`, `pipeline()` APIs, pause/resume, cross-session recovery, and token budget control.

```bash
/workflow run my-review --args directory="src/"
```

**适合场景**：批量代码审查、批量重构、文档生成流水线、多模型对比等确定性自动化任务。**不适合**需要与用户交互的场景（如 brainstorming），这类场景请用主线程 AI 直接对话。

### [subagent](./subagent/)

Task delegation & parallel execution — dispatch subagents in single/parallel/chain/background modes. Each subagent runs in an isolated Pi process.

```
> 并行审查这 3 个文件的代码质量
（AI 自动通过 subagent tool 并发 dispatch）
```

### [todo](./todo/)

Lightweight task list — `/todos` command + `todo` tool with pending/in_progress/completed states.

```bash
/todos
```

## Installation

Each extension can be installed globally or per-project by symlinking into the Pi extensions directory:

```bash
# Global
ln -s /path/to/xyz-pi-extensions/<name> ~/.pi/agent/extensions/<name>

# Project-local
ln -s /path/to/xyz-pi-extensions/<name> .pi/extensions/<name>
```

## License

MIT
