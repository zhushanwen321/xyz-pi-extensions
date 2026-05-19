# xyz-pi-extensions

Collection of custom extensions for [Pi coding agent](https://github.com/badlogic/pi-mono).

## Extensions

### [goal](./goal/)

Codex-style `/goal` command — persistent goal-driven autonomous loop with evidence-based completion, token/time budgets, blocked detection, and steering templates.

```bash
/goal Fix all failing tests --tokens 500000 --timeout 30
```

## Installation

Each extension can be installed globally or per-project by symlinking into the Pi extensions directory:

```bash
# Global
ln -s /path/to/xyz-pi-extensions/goal ~/.pi/agent/extensions/goal

# Project-local
ln -s /path/to/xyz-pi-extensions/goal .pi/extensions/goal
```

## License

MIT
