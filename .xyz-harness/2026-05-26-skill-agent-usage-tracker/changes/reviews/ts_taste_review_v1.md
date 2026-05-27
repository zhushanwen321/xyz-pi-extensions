---
verdict: pass
must_fix: 0
---

# TS 代码品味审查报告

**审查对象**: `usage-tracker/src/index.ts`（151 行）
**审查时间**: 2026-05-27
**审查工具**: 人工审查 + 自动化 taste-lint（ESLint）

---

## 自动化 Lint 结果

```
0 errors, 2 warnings (taste-lint)
```

| 规则 | 级别 | 位置 | 描述 |
|------|------|------|------|
| `no-magic-numbers` | warning | L60:57 | `JSON.stringify(stats, null, 2)` 的 `2` 是魔法数字 |
| `taste/no-silent-catch` | warning | L61:4 | `incrementAndPersist` 的 catch 块只有 console.error |

---

## 逐项审查

### P0 — 原则违反（必须修复）

| # | 类别 | 位置 | 描述 | 建议 |
|---|------|------|------|------|
| — | — | — | 无发现 | — |

**详细说明**：

- **文件长度**：151 行，远超 300 行红线。**通过**。
- **单文件多职责**：文件聚焦"skill 和 agent 调用计数"一个关注点，事件处理逻辑清晰分离。**通过**。
- **未约束的 `any`**：源代码中无任何 `any` 类型。`Partial<UsageStats>` 是合法的结构化 Partial 类型。**通过**。
- **`Record<string, unknown>` + `as` 组合**：两处使用均属 Pi 扩展外部接口边界：
  - L84: `event.input as Record<string, unknown>` — Pi SDK 的 `tool_call` 事件输入类型即为 `Record<string, unknown>`，属于外部接口签名（白名单场景）。
  - L126: `(event.input as { path: string }).path` — `read` 工具输入的结构化断言，作用域极小。
  - 内部 `extractAgentNames` 函数使用运行时类型守卫（`typeof` / `Array.isArray`）而非盲 `as` 断言，符合 taste 要求。**通过**。
- **类型定义与实际数据一致性**：`UsageStats` 接口字段均使用了运行时防御（typeof 检查后赋值），且字段如实对应数据。**通过**。
- **跨文件类型重复**：本文件是扩展唯一源文件，无交叉引用。**通过**。

### P1 — 偏好（推荐修复）

| # | 类别 | 位置 | 描述 | 建议 |
|---|------|------|------|------|
| 1 | 语义化命名 | L60 | `JSON.stringify(stats, null, 2)` 的 `2` 为魔法数字 | 提取为常量 `const JSON_INDENT = 2` |
| 2 | 错误反馈 | L61-63 | `incrementAndPersist` 的 catch 块仅 `console.error`，调用方无感知 | 当前作为非关键后台统计可接受，但可考虑将 STATS_FILE 写入失败回退到内存统计 |

**详细说明**：

1. **魔法数字 `2`**：`JSON.stringify` 的缩进参数 `2` 是广泛使用习惯，严格来说不构成维护问题。提取为常量纯粹是 taste 规则的形式要求。影响极小。
2. **Silent catch**：`incrementAndPersist` 的 catch 块只有 `console.error` 日志。背景：这是非关键功能——统计写入失败不应中断主流程。catch 块已经记录了文件路径和错误信息。`readStats` 的 catch 块则正确返回 `emptyStats()` 实现了降级。若需改进，可以让写入失败时回退到内存统计并在后续重试写入。

### P2 — 安全防御（必须修复）

| # | 类别 | 位置 | 描述 | 建议 |
|---|------|------|------|------|
| — | — | — | 无发现 | — |

**说明**：无认证操作、无 `eval`、无 `v-html`、无敏感数据泄露风险。日志中打印的文件路径为 `~/.pi/agent/usage-stats.json`，属于本地运营日志，不含凭据。**通过**。

### P3 — 细节

| # | 类别 | 位置 | 描述 | 建议 |
|---|------|------|------|------|
| — | — | — | 无发现 | — |

**说明**：无隐式依赖、结构清晰、职责单一。**通过**。

---

## 其他发现

### 值得肯定的模式

1. **`extractAgentNames` 使用运行时类型守卫**：函数签名接受 `Record<string, unknown>`，但内部使用 `typeof` / `Array.isArray` 逐层收窄类型，不依赖盲 `as` 断言。这是 taste 指南推荐的"运行时防御优于盲断言"模式。

2. **`readStats` 的防御性反序列化**：对 JSON 解析结果使用 `typeof` 检查确保每字段类型正确，即使文件损坏也返回安全初始值。符合"信任止于边界"原则。

3. **闭包状态 + `initialized` 守卫**：`skillMap` 和 `initialized` 封装在闭包内，`before_agent_start` 初始化后才响应 `tool_call`，防止竞态。符合 session 隔离要求。

4. **Read-before-write 防竞争**：`incrementAndPersist` 每次先 `readStats()` 再递增写入，防止多 session 并发覆盖。

### 潜在的改进方向（非当前问题）

- `LOG_PREFIX` 使用 `console.error`（stderr）而非 `console.log`（stdout），适合扩展场景——不污染主流程 stdout，但对 `err` 的参数传递（`${err}`, `STATS_FILE`）有的用字符串插值有的用参数传递，风格不够统一。
- `incrementAndPersist` 的 catch 块中 `stats[category]` 在 `try` 内被重新赋值 `= {}`。如果 `readStats()` 返回的 stats 中有该 category 但后续写入失败，`stats` 对象不会被持久化。这不是 bug——因为 `readStats()` 总是读最新磁盘数据，下次调用会重新读取。

---

## 汇总

| 优先级 | 数量 | 状态 |
|--------|------|------|
| P0（必须修复） | 0 | — |
| P1（推荐修复） | 2 | 魔法数字 `2` + silent catch |
| P2（安全修复） | 0 | — |
| P3（细节） | 0 | — |

**结论**: 代码质量良好，结构清晰，类型安全措施得当。两项 P1 发现均不影响功能正确性，建议在后续重构或功能追加时顺手修复，无需单独处理。

**Verdict**: `pass` | **Must fix**: `0`
