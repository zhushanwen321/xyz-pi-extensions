---
verdict: pass
must_fix: 0
reviewer: ts-taste-check
date: 2026-05-31
scope:
  - skill-state/src/state.ts
  - skill-state/src/templates.ts
  - skill-state/src/index.ts
---

# TypeScript 品味审查报告 — skill-state

## 自动化检测

| 检查项 | 结果 |
|--------|------|
| ESLint taste-lint (`--max-warnings=0`) | ✅ 0 warnings, 0 errors |
| TypeScript `--noEmit` | ✅ 无类型错误 |
| `no-explicit-any` | ✅ 全文件无 `any` |

## 文件概览

| 文件 | 行数 | 职责 |
|------|------|------|
| `state.ts` | 102 | 类型定义、状态机、序列化 |
| `templates.ts` | 41 | Steering 提示词模板 |
| `index.ts` | 356 | 扩展工厂，注册 tool/command/events |

## 逐文件审查

### state.ts（102 行）

| 优先级 | 类别 | 位置 | 描述 | 判定 |
|--------|------|------|------|------|
| — | 结构 | 全文件 | 102 行，纯数据层，职责单一（类型 + 状态机 + 序列化） | ✅ 合格 |
| — | 命名 | L30 | `MIN_PATH_SEGMENTS = 2` 语义化常量 | ✅ 合格 |
| — | 类型 | L88-99 | `deserializeState` 中 `as TrackedItemStatus` / `as TrackedItem[]` | ✅ 边界反序列化断言，配 defaults fallback，合理 |
| — | 结构 | L25-28 | `ALLOWED_TRANSITIONS` 用 `ReadonlyMap` + `ReadonlySet` | ✅ 不可变数据，显式意图 |

**结论**：无问题。

### templates.ts（41 行）

| 优先级 | 类别 | 位置 | 描述 | 判定 |
|--------|------|------|------|------|
| — | 结构 | 全文件 | 41 行，纯函数，无副作用 | ✅ 合格 |
| — | 职责 | 全文件 | 集中管理所有 steering prompt，与业务逻辑分离 | ✅ 合格 |

**结论**：无问题。

### index.ts（356 行）

| 优先级 | 类别 | 位置 | 描述 | 判定 |
|--------|------|------|------|------|
| — | 结构 | 全文件 | 356 行，单文件含工厂 + helpers + tool + 渲染 | ✅ <500 行，职责可一句话概括（扩展注册胶水） |
| — | 命名 | L23-24 | `REMIND_INTERVAL = 10`, `ERROR_THRESHOLD = 2` 语义化常量 | ✅ 合格 |
| — | 类型 | L157-163 | `persistState` 中 `entry.customType === ENTRY_TYPE` | ✅ Pi API entries 的标准匹配模式 |
| — | 类型 | L172-180 | `reconstructState` 中 `entries[i].data as Record<string, unknown>` | ✅ Pi 持久层边界，数据来源 untyped |
| — | 错误处理 | L216-228 | `executeSkillState` 用 `throw new Error()` 拒绝非法输入 | ✅ 符合项目规范 |
| — | 状态管理 | L301 | `let state = createInitialState()` 闭包变量 + session_start 重建 | ✅ 多 session 安全 |
| — | 渲染 | L260-275 | `renderCall`/`renderResult` 用 `theme.fg()` 语义 token | ✅ 不硬编码 ANSI |

## Record\<string, unknown\> 白名单审查

项目中存在以下 `Record<string, unknown>` 使用：

| 文件 | 位置 | 场景 | 判定 |
|------|------|------|------|
| `index.ts` | event handler 参数 | Pi 事件 API 签名，事件数据无结构化类型 | ✅ 边界（Pi Runtime → 扩展） |
| `index.ts` | `reconstructState` | 从 Pi entry 反序列化 | ✅ 边界（持久层 → 运行时） |
| `state.ts` | `serializeState`/`deserializeState` | 状态序列化/反序列化 | ✅ 跨层序列化 |

所有 `Record<string, unknown>` 均位于 Pi API 边界（事件入参 + 持久层反序列化），属于「外部接口签名」白名单场景。内部逻辑全部使用结构化类型（`TrackedItem`、`SkillStateRuntimeState`）。

## 跨文件重复检查

- `TrackedItem` / `TrackedItemStatus` / `SkillStateRuntimeState` 仅在 `state.ts` 定义，`templates.ts` 和 `index.ts` 通过 import 引用
- 无同名 interface 在多文件重复定义
- 无重复工具函数

## 汇总

| 优先级 | 数量 |
|--------|------|
| P0（必须修复） | 0 |
| P1（推荐修复） | 0 |
| P2（安全防御） | 0 |
| P3（细节） | 0 |

**总评**：代码质量优秀。文件职责划分清晰（数据模型 / 提示词模板 / 扩展注册），状态机转换矩阵显式声明，序列化层向后兼容，命名常量使用合理。`Record<string, unknown>` 全部限制在 Pi API 边界，内部逻辑类型安全。无需修复项。
