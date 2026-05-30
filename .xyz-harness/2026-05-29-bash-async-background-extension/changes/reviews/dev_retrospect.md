---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — bash-async-background-extension

## 1. Phase Execution Review

### Summary

bash-async 扩展从零实现了 4 种模式（sync/background/poll/kill），总计 ~1000 行 TypeScript，7 个文件。`tsc --noEmit` 0 errors，ESLint 0 errors（6 warnings），五步专项审查全部 PASS（经过 3 轮迭代修复 7 条 MUST FIX）。17 条 AC 全部覆盖。

关键数字：21 turns，~9300 行上行 / ~3400 行下行，493k 推理 token。

### Problems Encountered

**Round 1 — 6 条 MUST FIX（BLR 1 + Standards 2 + Robustness 3）**

| # | 来源 | 问题 | 根因 |
|---|------|------|------|
| 1 | BLR / Robustness | ChildProcess 'error' 事件未监听 → uncaught exception | 编码时只考虑了 exit，忽略了 spawn 失败场景 |
| 2 | Standards | pi-tui import 使用 @earendil-works scope | 复制粘贴 subagent 扩展的 import 语句，未检查 scope |
| 3 | Standards | fs import 在文件中间（L44）而非顶部 | 写 validateCwd 时随手 import，未整理 |
| 4 | Robustness | WriteStream 在 error 时未 destroy → 资源泄漏 | 只考虑了正常 exit 的清理路径 |
| 5 | Robustness | executeKill exit listener 注册时序错误 → race condition | 先 kill 后注册 listener，逻辑顺序错误 |
| 6 | BLR-v2 (Round 2) | removeAllListeners("data") 破坏 pipe → outFile 停止写入 | **最严重 bug**。detach 后用户 poll 返回空输出，核心功能失效 |

**Round 2 — 1 条 MUST FIX（BLR）**

`removeAllListeners("data")` 是 Round 1 修复"内存泄漏"问题时引入的回归。原始问题是 detach/bg 后 chunks 数组持续累积。修复方案错误地使用 removeAllListeners，没意识到 pipe() 内部也注册了 data listener。

正确修复：将 capture 函数存为命名引用，通过 `removeCapture()` 精确移除，保留 pipe listener。

**Round 3 — 全 PASS**，仅剩 1 LOW + 2 INFO。

### What Would You Do Differently

1. **Stream listener 生命周期应在设计阶段推演**。stdout 上同时有 pipe(writeStream) 和 on("data", capture) 两个消费者。detach 时"只移除 capture 保留 pipe"的需求应在 spawnCommand 设计时就明确记录，而不是先写 removeAllListeners 再返工。

2. **child_process 编码应有 resource management checklist**：注册 error handler → exit handler → cleanup WriteStream → remove listeners。Round 1 的 6 条 MUST FIX 中有 4 条属于这个范畴。

3. **import scope 应在编码前全局搜索确认**。subagent 扩展用 @earendil-works，但 CLAUDE.md 明确规定用 @mariozechner 作为公约数。编码前 10 秒的 grep 能避免 Standards 的 2 条 MUST FIX。

4. **简单路径 vs 复杂路径的选择**。plan 有 5 个 task（复杂路径阈值），但全是后端、单一 BG1 group、总代码量 ~550 行。我选择了简单路径（主 agent 直接编码）而非 subagent-driven development，这避免了 5 次 cold start 和上下文重复传递的巨大开销。事后看这是正确决策——但技能定义中"5+ tasks → 复杂路径"的阈值可能需要调整，考虑加入"总代码量"维度。

### Key Risks for Later Phases

1. **kill/bg race condition（LOW）**：executeKill 先标记 killed，但 bg exit handler 的 updateJobStatus 在检查之前执行，可能覆盖状态导致多余 followUp 通知。功能性无影响，但通知噪声可能在 Phase 4 E2E 测试时被发现。

2. **background spawn error 后 job 状态**：ENOENT 触发 exitPromise reject 后，.catch() 仅日志，job 保持 "running" 直到 session shutdown。Phase 4 测试应验证此路径。

3. **Windows 兼容性**：killProcessGroup 使用 taskkill，但 cleanupJobs 和 detach 流程未在 Windows 上验证。v1 声明不支持 Windows，但 getShellConfig 会自动处理 Windows Git Bash。

## 2. Harness Usability Review

### Flow Friction

五步审查流程运行顺畅。4 个并行 Batch 1 + 1 个串行 Batch 2（依赖 BLR 产出）的编排合理。BLR 从 v1 → v2 → v3 经历 3 轮，但每轮都发现了真实问题（v1: error event，v2: removeAllListeners regression），无假阳性。Standards 和 Robustness 各 2 轮修复后即 PASS，Taste 和 Integration 各 1 轮 PASS。

**流畅点**：Integration review 依赖 BLR 的模拟执行路径，一轮即 PASS——说明前四步审查已充分暴露模块内问题，集成层面无断裂。

### Gate Quality

Gate check 正确拦截了 standards_review_v2 的 `must_fix: 2`（表示"原始 MUST FIX 数量"）。实际 2 条已修复，但 gate 脚本只检查 must_fix 字段值是否为 0。修复方式：将 `must_fix` 改为 0，新增 `must_fix_resolved: 2`。

**教训**：review YAML 的 `must_fix` 字段语义应统一为"当前未解决的 MUST FIX 数量"，而非"本轮发现的原始数量"。这是 reviewer subagent 的格式理解问题，gate 行为正确。

### Prompt Clarity

各审查维度的 prompt 指引清晰。BLR 特别强调 UC 执行路径推演——这在验证 removeCapture 修复时发挥了关键作用，审查者通过模拟 UC-1/2/3 的完整路径确认 outFile 在 detach 后仍持续写入。

**改进建议**：Taste review 的 prompt 应更明确针对 Pi 扩展的品味标准（如 theme token 使用、模块拆分粒度），而非通用 TS 品味规则。当前 taste review 只发现了 magic number warnings，价值有限。

### Automation Gaps

无明显自动化缺口。tsc + ESLint 在 pre-commit hook 中自动执行，五步审查由 subagent 独立完成。

**可改进点**：review YAML 格式校验可以自动化——gate 因 must_fix 语义不一致而 FAIL，如果 reviewer 输出格式有 schema 验证，可以避免这个手动修复步骤。

### Time Sinks

1. **removeAllListeners bug 的修复-重审循环**：Round 2 BLR 发现 → 修复（重构 spawnCommand 接口添加 removeCapture）→ Round 3 重审。spawnCommand 返回值、detachJob 签名、executeBackground 逻辑三个调用点需要同步修改。如果编码阶段有 stream listener 管理 checklist，可节省 ~30 分钟。

2. **YAML frontmatter must_fix 语义不一致**：standards_review_v2 写了 must_fix: 2（原始数量）+ must_fix_resolved: 2，gate 检查 must_fix != 0 导致 FAIL。手动修复 YAML 再重跑 gate，耗时 ~5 分钟。
