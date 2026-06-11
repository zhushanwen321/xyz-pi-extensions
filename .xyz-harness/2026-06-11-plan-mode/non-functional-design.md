---
verdict: pass
---

# Non-Functional Design — Pi Plan Mode Extension

## 1. 稳定性

**风险:** Plan mode 的 compact 操作可能导致上下文丢失。

**缓解:** 降级策略——compact 失败时自动切换为直接继续，通过 `ctx.ui.notify` 提示用户。不阻塞流程。

**影响范围:** 仅影响当前 session，不影响其他 session 或 Pi 进程稳定性。

## 2. 数据一致性

**存储方案:** Plan state 通过 `appendEntry("plan-state", data)` 持久化到 session JSONL。

**并发控制:** 单 session 内串行操作，无并发问题。多 session 隔离由 `ctx.sessionManager` 保证。

**YAML frontmatter:** Plan 文件的 YAML frontmatter 由 AI 写入，格式简单（template, created, status），无复杂嵌套，解析失败不影响文件内容。

## 3. 性能

**模板发现:** `listTemplates()` 扫描 3 个目录（project, global, builtin），文件数通常 < 20，性能无问题。

**状态重建:** `reconstructPlanState()` 从 entries 反向扫描，找到最新 plan-state 即停止，O(n) 但 n 通常 < 100。

**Compact:** 由 Pi 核心处理，plan extension 仅触发，不增加额外开销。

## 4. 业务安全

**SKILL.md 作为 AI 行为指令:** Plan mode 的 SKILL.md 告知 AI 禁止编辑非 plan 文件。这是提示词约束，非硬性拦截。

**风险:** AI 可能违反约束执行写入操作（概率低）。

**缓解:** 用户在 review 时可发现违规操作并 abort。Plan 文件在 /tmp，不直接影响项目代码。

## 5. 数据安全

**敏感信息:** Plan 文件可能包含项目内部信息（代码结构、API 设计等）。

**存储位置:** `/tmp` 目录，不主动清理，依赖 OS 的 /tmp 清理机制。

**权限控制:** Plan 文件权限继承 /tmp 目录默认权限（通常 755），无额外安全风险。

**跨 extension 调用:** `__goalInit` 是内部 API，通过 `(pi as Record<string, unknown>)` 访问，不暴露给外部。
