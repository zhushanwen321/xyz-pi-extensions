---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 1
  dimensions_checked: 6
  issues_found: 5
  must_fix_count: 0
  low_count: 3
  info_count: 2
  duration_estimate: "15"
---

# Robustness Review v1

## 审查记录
- 审查时间：2026-05-27 12:00
- 审查文件数：1
- 审查维度：D1-D6（全量）
- 文件：`usage-tracker/src/index.ts`

## 维度评分概览

| 维度 | 检查项数 | 通过 | 问题 | 评分 |
|------|---------|------|------|------|
| D1 错误处理 | 8 | 6 | 2 | 8/10 |
| D2 异常处理 | 4 | 3 | 1 | 8/10 |
| D3 日志 | 6 | 5 | 1 | 8/10 |
| D4 Fail-fast | 5 | 4 | 1 | 8/10 |
| D5 测试友好性 | 5 | 3 | 2 | 7/10 |
| D6 调试友好性 | 4 | 4 | 0 | 9/10 |

## 问题清单

| # | 严重度 | 维度 | 描述 | 文件 | 行号 | 修改建议 |
|---|--------|------|------|------|------|---------|
| 1 | LOW | D4,D5 | `event.input.path` 无运行时守卫，TypeScript cast 绕过运行时安全 | index.ts | L76 | 添加 `typeof path === 'string'` 检查，避免 `resolve(undefined)` 抛异常 |
| 2 | LOW | D3 | 所有日志均使用 `console.error()`，信息性日志与错误日志混合输出 | index.ts | 全局 | 信息性日志改用 `console.log()`，区分 stderr/stdout |
| 3 | LOW | D5 | `STATS_FILE` 为模块级常量不可注入，`readStats`/`incrementAndPersist` 非导出，测试无法 mock | index.ts | L22, L38, L57 | 将 `STATS_FILE` 改为可选参数或通过调用方传入 |
| 4 | INFO | D1 | `readStats()` 在文件损坏时静默返回空数据，丢失异常提示 | index.ts | L51 | 考虑在 catch 中标记内部状态 `corrupted=true`，下次写入时触发修复 |
| 5 | INFO | D1 | `incrementAndPersist` 对 `category`/`name` 无参数校验，空字符串/非法值会创建脏数据 | index.ts | L57 | 添加 `if (!name)` early return |

## 逐文件详情

### usage-tracker/src/index.ts (107 行)

**D1 错误处理:**
- ✅ L38-54 `readStats()`: 外部依赖（文件 I/O + JSON.parse）包裹 try/catch，降级返回 `emptyStats()`
- ✅ L57-68 `incrementAndPersist()`: writeFileSync 包裹 try/catch，降级日志写入失败
- ✅ 错误路径不阻塞主流程，细粒度降级而非大面积 try
- ⚠️ L51 (INFO #4): 文件损坏时静默返回空数据，调用方无法区分「第一次启动」和「文件已损坏」
- ⚠️ L57 (INFO #5): `category` 和 `name` 缺少入口校验，空字符串会产生 `stats["skills"][""]` 脏数据

**D2 异常处理:**
- ✅ 无空 catch 块（所有 catch 块都记录日志）
- ✅ try 块范围合适（每个 try 包裹单一操作：读、写、解析）
- ✅ 异常信息包含上下文（文件路径 + 错误对象）
- ⚠️ `catch (err)` 无类型收窄——对 I/O 操作实际影响小，类型安全性可改进

**D3 日志:**
- ✅ 关键路径有日志：skill map 构建、skill 命中、agent 调用、读写失败
- ✅ 错误日志包含上下文信息（文件路径、错误对象、名称）
- ✅ 无敏感数据泄露
- ⚠️ LOW #2: 全部使用 `console.error()` 输出，信息性日志（"Skill loaded"、"Agent called"）与真正错误日志混在同一流中，增加运维噪音

**D4 Fail-fast:**
- ✅ `before_agent_start`: 前置条件 `Array.isArray(skills)` 检查
- ✅ `tool_call`: `initialized` 守卫防止未初始化时处理请求
- ✅ `extractAgentNames`: 对 `input.agent`/`.tasks`/`.chain` 逐个做类型+长度校验
- ⚠️ LOW #1: `(event.input as { path: string }).path` — 纯 TypeScript 类型断言无运行时效果，如果 pi API 改版或 `path` 缺失，`resolve(undefined)` 在 Node 20+ 会抛 TypeError。理想做法加运行时守卫

**D5 测试友好性:**
- ✅ `extractAgentNames()` 是纯函数，隔离性极好
- ✅ `emptyStats()` 是纯工厂函数，可独立测试
- ✅ `skillMap` 和 `initialized` 为闭包变量，session 隔离良好
- ⚠️ LOW #1 (同 D4): input 解析逻辑与事件处理器耦合，未提取为可独立测试的函数
- ⚠️ LOW #3: 持久化函数依赖模块级 `STATS_FILE` 常量，测试只能通过 mock fs 模块或写入真实目录来验证行为

**D6 调试友好性:**
- ✅ 所有错误信息包含文件路径 + 错误对象（如 `Failed to read stats file: ${err} ${STATS_FILE}`）
- ✅ catch 块日志保留 `err`，包含堆栈信息
- ✅ 关键路径有状态变化日志（"Skill map built: N entries"）
- ✅ 日志中的名称和路径可直接用于排查映射问题

## 结论

健壮性整体良好。文件 I/O 路径有完整 try/catch 降级逻辑，异常信息包含充分上下文，无空 catch 块，fail-fast 守卫覆盖了主要前置条件。5 个发现问题均为 LOW 或 INFO 级别，无 MUST_FIX。

最值得关注的改进点：通过 TypeScript 类型断言访问 `event.input.path` 缺少运行时守卫（LOW #1），所有日志混用 `console.error()` 增加噪音（LOW #2）。
