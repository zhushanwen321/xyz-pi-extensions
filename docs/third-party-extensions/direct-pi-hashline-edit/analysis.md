# pi-hashline-edit — 直接安装分析

## 基本信息

| 维度 | 信息 |
|------|------|
| 原始仓库 | [RimuruW/pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit) |
| Stars | 76 |
| 安装方式 | direct-install |
| 安装日期 | 2025-06-01 |

## 选择直接安装的理由

1. **解决真实痛点**：AI 编辑文件时行号偏移导致后续编辑命中错误行，这是所有 coding agent 的通用问题
2. **独立性强**：不与我们的 goal/todo/subagent 等扩展冲突，纯增强 read/grep/edit 基础工具
3. **质量可靠**：有完整测试套件、清晰的 README、活跃维护
4. **零侵入**：通过 Pi 扩展 API override 内置工具，不需要修改 Pi 核心

## 核心设计

- 读取文件时，每行输出 `LINE:HASH|content` 格式（SHA1 前 8 位哈希）
- 编辑时用哈希定位行，而非行号
- 完全替代 Pi 内置的 read、grep、edit 工具

## 与我们扩展的关系

- **subagent**：子 agent 经常遇到编辑后行号偏移问题，hashline-edit 可直接解决
- **context-engineering**：哈希行会增加约 15% 的 token 开销，需要在压缩时考虑
- **unified-hooks/edit-stale-content-guard**：已被移除（见下方）
- **其他扩展**：无冲突

## 移除的扩展：edit-stale-content-guard

| 维度 | 说明 |
|------|------|
| 移除日期 | 2026-06-01 |
| 原始位置 | `unified-hooks/src/hooks/edit-stale-content-guard.ts` |
| 移除原因 | 被 pi-hashline-edit 完全替代 |

edit-stale-content-guard 是一个 `tool_call`/`tool_result` hook，在 edit 失败时拦截并 dump 文件当前内容，帮助 AI 重试。它检测的是 `oldText` 文本匹配失败。

pi-hashline-edit 替换了内置 edit 工具，使用 hash 锚点（`LINE#HASH`）定位行。这导致 guard 完全失效：

1. **参数不匹配**：pi-hashline-edit 的 edit 参数是 `pos: "36#MV"` 锚点格式，不含 `oldText` 字段，guard 的 `getEditInput()` 返回 null 直接跳过
2. **错误格式不匹配**：pi-hashline-edit 的错误是 `[E_STALE_ANCHOR]`，不含 guard Layer 2 检测的 `"Could not find"` 文本
3. **功能被覆盖**：pi-hashline-edit 内置 stale anchor 检测，返回精确到行的新 `>>> LINE#HASH` 锚点，比 guard 的全文件 dump 更高效

两者解决同一个问题（edit 因内容过期失败），但 pi-hashline-edit 从工具层根本性地解决了它。

## 后续计划

- 持续使用，已验证 token 开销可接受
- 关注 pi-hashline-edit 更新，如有 bug 上报 issue
