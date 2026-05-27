---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-27T20:30:00"
  target: "git diff HEAD~1 HEAD -- evolution-engine/"
  verdict: fail
  summary: "3条MUST FIX：extractReportSubset缺少merge-reviewer分支导致数据错误、monitor.ts跨扩展边界logger导入可能运行时崩溃、/evolve命令处理器不支持merge-reviewer参数。需修改后重审。"

statistics:
  total_issues: 5
  must_fix: 3
  must_fix_resolved: 0
  low: 2
  info: 0

issues:
  - id: 1
    severity: MUST_FIX
    location: "evolution-engine/src/judge.ts:57-68 (extractReportSubset)"
    title: "extractReportSubset 缺少 merge-reviewer 分支，落入 skills 提取路径"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "evolution-engine/src/monitor.ts:10"
    title: "logger import 跨扩展目录边界，可能运行时解析失败"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "evolution-engine/src/index.ts:346-354"
    title: "/evolve command handler 未解析 merge-reviewer target"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: LOW
    location: "evolution-engine/src/types.ts:90-93 (EvolveCommandParams)"
    title: "EvolveCommandParams.target 类型缺失 merge-reviewer"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "evolution-engine/src/commands.ts:242-245"
    title: "diffPreview 变量缩进不一致"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 业务逻辑评审 v1

## 评审记录
- 评审时间：2026-05-27 20:30
- 评审类型：业务逻辑评审（编码评审）
- 评审对象：`git diff HEAD~1 HEAD -- evolution-engine/`
- 被评审交付物：merge-reviewer 模板 + 配套支持代码（7 个文件变更，1 个新文件）

### 文件清单
| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `evolution-engine/src/index.ts` | 修改 | Tool 参数 enum 加入 merge-reviewer |
| `evolution-engine/src/commands.ts` | 修改 | analyzer 存在检查 + diffPreview 显示 |
| `evolution-engine/src/judge.ts` | 修改 | TARGET_TEMPLATE 加入 merge-reviewer |
| `evolution-engine/src/monitor.ts` | 修改 | 引入共享 logger 记录 auto-trigger 日志 |
| `evolution-engine/src/types.ts` | 修改 | JudgeInput.target 加入 merge-reviewer |
| `evolution-engine/src/templates/merge-reviewer.txt` | **新增** | 合并审查模板 |
| `evolution-engine/tests/integration.test.mts` | 修改 | 硬编码路径改为动态解析 |

---

### 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | `judge.ts:57-68` | **extractReportSubset 缺少 merge-reviewer 分支**。当 `target="merge-reviewer"` 时，函数落入 `else` 分支（原仅用于 `"skills"`），提取 `skill_stats` + `skill_health` + `actionable_issues`。但 merge-reviewer 模板期望的输入数据是 `tool_stats` + `error_stats` + `user_patterns`（spec 的 UC-5 明确标注）。LLM Judge 收到错误数据，将基于 skill 健康数据生成「PR 合并质量」建议，产出无意义。 | 在 `extractReportSubset` 中新增 `target === "merge-reviewer"` 分支，提取 `tool_stats`、`error_stats`、`user_patterns` 三个字段。 |
| 2 | MUST FIX | `monitor.ts:10` | **logger import 跨扩展目录边界**。`import { createLogger } from "../../shared/logger.js"` 引用源文件为 `shared/logger.ts`（位于 workspace 根目录）。当 extension 通过 symlink 安装到 `~/.pi/agent/extensions/evolution-engine/` 时，Node.js 的 `import` 路径解析取决于是否 follow symlink：若按 symlink 路径解析则为 `~/.pi/agent/extensions/shared/logger.js`（不存在）。且文件为 `.ts` 但 import 写 `.js`，依赖 Pi 运行时的 `.js`→`.ts` 隐式解析。若加载失败，`index.ts` 中 `import { checkAutoTriggerRules } from "./monitor"` 也失败，导致 `session_start` 事件处理器崩溃，整个扩展的自动触发功能不可用。 | 三种方案：(a) 将 logger 模块内联到 `evolution-engine/src/logger.ts`，避免跨扩展引用；(b) 确保 `shared` 目录随 extension 一起部署（硬拷贝而非 symlink）；(c) 重建日志功能为独立 npm 包。建议方案 (a)，最轻量且隔离性好。 |
| 3 | MUST FIX | `index.ts:346-354` | **`/evolve` command handler 未解析 `merge-reviewer` target**。command handler 中只检查 `all`、`claude-md`、`skills` 三个值，用户输入 `/evolve merge-reviewer` 时 target 保持默认值 `all`。UC-5 的 Actor 是「Pi Agent 用户」，Main Flow 第一步就是用户通过 `/evolve target=merge-reviewer` 触发。command 不支持意味着 UC-5 主路径不通——用户无法通过命令访问新功能（tool 路径仍然可用，但 command 是主要交互界面）。 | (a) 在 target 类型变量中加入 `"merge-reviewer"`；(b) 在条件判断中加入 `part === "merge-reviewer"` 的分支。同时更新 `EvolveCommandParams.target` 类型（见 #4）。 |
| 4 | LOW | `types.ts:90-93` | **`EvolveCommandParams.target` 类型未更新**。Tool schema（`index.ts` 的 `EvolveParams`）已包含 `merge-reviewer`，`JudgeInput.target` 也包含，但 `EvolveCommandParams.target` 仍为 `"all" | "claude-md" | "skills"`。这会导致 `tsc --noEmit` 类型检查报错，且 handleEvolve 函数签名无法编译通过（如果严格 mode 检查调用链）。运行时不会直接报错（JS 环境无类型约束），但丢失了类型安全。 | 将 `EvolveCommandParams.target` 类型扩展为 `"all" | "claude-md" | "skills" | "merge-reviewer"`。 |
| 5 | LOW | `commands.ts:242-245` | **diffPreview 变量缩进不一致**。新增的 `const diffPreview` 和 `return` 语句的缩进层数与周围代码不匹配（减少了 2 层缩进）。这不会影响运行结果，但降低了代码可读性，在 future diff 中会导致视觉混乱。 | 将 `diffPreview` 声明和 `return` 的缩进与上方 `const diff` 对齐。 |

---

#### 等级判定说明

| # | 判定依据 |
|---|---------|
| 1 | **功能失效**：merge-reviewer 功能的数据流断裂。模板接收错误数据 ⇒ LLM 产出无意义建议 ⇒ 用户获得无用输出。特性和模板形同虚设。 |
| 2 | **功能失效**：若运行时无法解析 import，`session_start` 处理器崩溃 ⇒ 自动触发功能完全不可用。属于「该问题在生产环境会导致功能不可用」范畴。 |
| 3 | **功能失效**：UC-5 主流程要求的 command 入口不通。新功能对命令用户不可达。 |
| 4 | 类型安全缺失，运行时不受影响。不影响功能正确性。 |
| 5 | 代码风格问题，不影响业务逻辑。 |

---

### 与 Spec / Use-Cases 对照

| Spec/UC 要求 | 对应文件 | 覆盖状态 | 说明 |
|-------------|----------|---------|------|
| UC-5: `/evolve target=merge-reviewer` 触发 | `index.ts:346` | ❌ | Command handler 未解析 merge-reviewer |
| UC-5: `extractReportSubset` 提取 tool_stats + error_stats + user_patterns | `judge.ts:57` | ❌ | 实际提取了 skill_stats + skill_health |
| UC-5: Judge 使用 merge-reviewer 模板分析 | `judge.ts:23` | ✅ | TARGET_TEMPLATE 正确映射 |
| UC-5: 生成合并相关进化建议 | `judge.ts:42-55` | ❌ | 因数据错误，建议内容无意义 |
| D4.1: evolution-engine extension | — | ✅ | 骨架已完成 |
| D4.3: 审批交互 | `commands.ts:242` | ⚠️ | Diff preview 增强是正向改进，但缩进有小问题 |
| merge-reviewer 模板存在 | `templates/merge-reviewer.txt` | ✅ | 新文件，内容合理 |

---

### 结论

**需修改后重审。** 3 条 MUST FIX 问题中，**#1 是最严重的问题**——它导致新增的 merge-reviewer 功能数据流断裂，整个特性形同虚设。#2 影响已有功能（auto-trigger）的运行时稳定性。#3 阻塞 UC-5 的主交互路径。建议按优先级顺序修复：1 → 2 → 3。

### Summary

业务逻辑评审完成，第1轮需重审，3条MUST FIX。核心问题：extractReportSubset 缺少 merge-reviewer 分支导致数据错误；monitor.ts 跨边界 logger 导入可能运行时崩溃；/evolve 命令不支持 merge-reviewer 参数。
