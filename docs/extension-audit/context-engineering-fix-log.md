# Context Engineering — P1 修复日志

> 修复日期: 2026-06-05
> 基于审查报告: `docs/extension-audit/context-engineering.md`
> 包版本: 0.1.2

## 修复概览

| 问题 ID | 描述 | 状态 | 说明 |
|---------|------|------|------|
| P1-1 | `compressor.ts` 798 行超标 | ⏭️ 跳过 | 见下方详细说明 |
| P1-2 | 缺少 `types.ts`，跨文件类型散落 | ✅ 已修复 | |
| P1-3 | `peerDependencies` 与代码 import 不一致 | ✅ 已修复 | |
| P1-4 | `loadConfig` 解析失败时静默回退默认 | ✅ 已修复 | |
| P1-5 | 配置路径未走扩展专属目录 | ✅ 已修复 | |
| P1-6 | `handleContextEngineeringCommand` switch 后缺 return | ✅ 已修复 | |

---

## 已修复问题详情

### P1-2. 缺少 `types.ts`，跨文件类型散落

- **文件**: 新建 `src/types.ts`，修改 `src/compressor.ts`
- **变更**:
  1. 新建 `src/types.ts`（133 行），包含所有 16 个共享类型定义：
     - 内容块类型: `TextContent`, `ThinkingContent`, `ImageContent`, `ToolCall`
     - 消息类型: `UserMessage`, `AssistantMessage`, `ToolResultMessage`, `BashExecutionMessage`, `CompactionSummaryMessage`, `AgentMessage`
     - 域类型: `ContextUsage`, `TurnBoundary`
     - 统计类型: `L0Stats`, `CompressionStats`, `McStats`, `BudgetStats`
  2. `src/compressor.ts` 中删除内联类型定义（约 94 行），改为 `export type { ... } from "./types.ts"` re-export + `import type { ... }` 内部引用
  3. `compressor.ts` 行数从 798 降至 704（减少 94 行）
- **兼容性**: 由于 `compressor.ts` 保持了 re-export，所有消费方（`src/index.ts`、`src/commands.ts`、测试文件）的 import 路径无需修改
- **验证**: 44 个测试全部通过，typecheck 无新增错误

### P1-3. `peerDependencies` 声明与代码 import 不一致

- **文件**: `package.json`
- **变更**: `"@sinclair/typebox": "*"` → `"typebox": "*"`
- **理由**: 代码中 `import { Type } from "typebox"`，peerDependencies 应与实际 import 字符串一致。`typebox` (v1.x) 是本仓库 `@mariozechner/pi-coding-agent` 依赖的同一作者包

### P1-4. `loadConfig` 读取/解析失败时静默回退默认

- **文件**: `src/config.ts`（`loadConfig` 函数）
- **变更**:
  - 文件读取失败（`catch`）: 检查 `err.code === "ENOENT"` → 文件不存在时返回默认值（正常场景）；其他读取错误抛出含路径和原因的 Error
  - JSON 解析失败（`catch`）: 不再静默回退，抛出 `Invalid JSON in ${filePath}: ${err.message}`
- **理由**: 规范 8.2 要求"配置加载失败必须抛有意义的错误（包含路径和原因），不能静默使用默认值"。JSON 语法错误是用户配置问题，必须暴露

### P1-5. 配置路径未走扩展专属目录

- **文件**: `src/config.ts`（`loadConfig` 函数）
- **变更**: 默认路径从 `~/.pi/agent/settings.json` 改为 `~/.pi/agent/extensions/context-engineering/config.json`
- **理由**: 规范 8.1 要求"配置路径使用 `~/.pi/agent/extensions/<extension-name>/config.json` 子目录"，与 Pi 核心配置隔离，便于独立管理和卸载

### P1-6. `handleContextEngineeringCommand` switch 后缺 return

- **文件**: `src/commands.ts`（`handleContextEngineeringCommand` 函数）
- **变更**: 在 switch 块后追加 `return USAGE_HELP;` 作为防御性兜底
- **理由**: 规范 10.4 要求"函数内所有可能的控制流路径必须有显式的 return"。虽然 TypeScript 能推断 switch 穷尽了 `parseLevelArgs` 的返回值类型（target 收窄为 `never`），但未来如果修改 `parseLevelArgs` 返回类型或漏掉 case，会导致运行时隐式返回 `undefined`

---

## 跳过问题详情

### P1-1. `compressor.ts` 文件严重超标（798 行）

- **跳过原因**: 
  1. **超出最小变更原则**: 拆分 798 行文件为 7 个子文件（如审查报告建议的 `compressor/l0.ts`、`compressor/l1.ts` 等）属于重大结构重构，涉及所有 import 路径变更、3 个测试文件的 import 更新、以及模块可见性重新划分
  2. **未触发 P0 红线**: 当前 798 行低于 Monorepo 约定的 1000 行 P0 红线。P1-2 的修复已将 `compressor.ts` 降至 704 行，距离 500 行规范上限更近了一步
  3. **回归风险**: 拆分过程中内部函数的 `export`/模块可见性变化可能引入测试回归，需要额外的集成验证
- **建议**: 在 0.2.0 版本中作为专项重构任务执行，配合完整的 E2E 测试覆盖

---

## 验证结果

- **TypeScript 编译**: `tsc --noEmit` 对 `extensions/context-engineering/` 无新增错误
- **单元测试**: `vitest run` — 3 个测试文件、44 个测试用例全部通过
- **文件变更汇总**:
  - 新增: `src/types.ts`（133 行）
  - 修改: `src/compressor.ts`（798→704 行，-94 行内联类型定义）
  - 修改: `src/config.ts`（175→176 行，loadConfig 错误处理 + 路径变更）
  - 修改: `src/commands.ts`（157→159 行，switch 后加 return）
  - 修改: `package.json`（peerDependencies 更正）
