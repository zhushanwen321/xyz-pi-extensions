# extensions 文档

存放单个 extension 的**内部文档**（架构、数据模型、执行流程等真相源）。

## 结构

每个 extension 一个子目录：

```
extensions/<name>/
├── architecture.md   — 架构与契约（真相源）
├── data-model.md     — 数据模型（可选）
└── ...
```

## 归属判定

- 文档只对一个 extension 有意义 → 放这里
- 跨 extension 的通用规范 → `docs/` 根级（见 [../README.md](../README.md)）
- extension 的**调研材料**（竞品分析等）→ `docs/research/<topic>/`（不按 extension 归类）
- extension 的 CHANGELOG / README → extension 源码目录（`extensions/<name>/`），不放这里

## 现有文档

- [`subagents/`](./subagents/) — Subagents 扩展内部架构（architecture / data-model / execution-flow / session-runner）
