---
review:
  type: spec_review
  round: 2
  timestamp: "2026-05-30T16:00:00"
  target: ".xyz-harness/2026-05-29-bash-async-background-extension/spec.md"
  verdict: pass
  summary: "Spec v2 评审通过。5 条 MUST FIX 全部修复，架构冲突根因已解决。发现 2 条 LOW（settings.json 读取路径精度、临时文件 path 重新 pipe 细节），不阻塞。"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 5
  low: 2
  info: 3

issues:
  # ===== Round 1 MUST FIX — 验证修复 =====
  - id: 1
    severity: MUST_FIX
    location: "spec.md FR-1"
    title: "BashOperations.exec() 超时会 kill 进程，与「不 kill」需求不可兼得"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-1 明确改用 child_process.spawn 直接管理，不再使用 BashOperations.exec()。Constraints 段落也确认了这一选择。"

  - id: 2
    severity: MUST_FIX
    location: "spec.md FR-1 Shell 发现逻辑"
    title: "getShellConfig / getShellEnv 不是公开 API，无法从 createLocalBashOperations 提取"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-1 明确「参照 Pi 内部 getShellConfig 实现自行编写，约 30 行」。Constraints 段落也注明 Pi 不导出这些函数。经验证，Pi bash.js 中 getShellConfig 约 20 行，getShellEnv 约 10 行，30 行估计合理。"

  - id: 3
    severity: MUST_FIX
    location: "spec.md FR-3"
    title: "BashOperations.exec() 是阻塞调用，无法「spawn 后立即返回」"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "与 Issue #1 同根因。FR-1 改用 child_process.spawn 后，Background 模式可 spawn 后不 await，立即返回 jobId。subagent 扩展已验证此模式可行（spawn.ts 使用 import { spawn } from 'node:child_process'）。"

  - id: 4
    severity: MUST_FIX
    location: "spec.md FR-1 命令前缀"
    title: "设置读取机制未明确：ToolCallEvent 不暴露其他工具的 settings"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-1 改为「从 Pi settings 文件（~/.pi/agent/settings.json）读取 shellCommandPrefix 字段」。经验证：(1) settings.json 确实存储在 ~/.pi/agent/settings.json；(2) SettingsManager 支持 shellPath 和 shellCommandPrefix 字段（settings-manager.d.ts:70,72）；(3) 扩展通过 fs.readFileSync 直接读取即可，不需要 ExtensionAPI 暴露 settingsManager。"

  - id: 5
    severity: MUST_FIX
    location: "spec.md FR-3 sendMessage"
    title: "Background job 完成回调缺少生命周期安全描述"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-3 明确：(1) pi 在 session_start 闭包中捕获；(2) sendMessage 调用需 try-catch，session shutdown 时忽略错误（参考 subagent spawn.ts:429）；(3) FR-6 补充 sendMessage 错误不传播。FR-3 的描述准确反映了 subagent 扩展的实践模式。"

  # ===== Round 1 LOW/INFO — 验证是否被采纳 =====
  - id: 6
    severity: LOW
    location: "spec.md FR-8"
    title: "setInterval + context.invalidate() 对 background job 不可用"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-8 已修改：sync 模式执行中使用 setInterval 刷新耗时（与内置 bash 一致），background 模式返回静态确认信息，后续状态通过 poll。经验证，内置 bash 的 renderResult 确实使用 setInterval(() => context.invalidate(), 1000) 实现耗时刷新（在 options.isPartial 为 true 时），spec 描述准确。"

  - id: 7
    severity: LOW
    location: "spec.md 全文"
    title: "未限制最大并发 background job 数量"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "新增 FR-12 并发限制，默认 10，可配置。AC-15 验证。FR-10 配置文件中增加 maxBackgroundJobs 字段。"

  - id: 8
    severity: INFO
    location: "spec.md FR-7"
    title: "临时文件清理策略仅覆盖 session_shutdown"
    status: open
    raised_in_round: 1
    resolved_in_round: null
    note: "Spec 选择方案 B——明确「临时文件在 session 期间持续增长，session_shutdown 时清理」作为已知限制。这对 Pi 的使用模式（session 通常不超过数小时）可接受。plan 阶段可考虑 poll 后截断已读部分作为优化，但非 MUST FIX。"

  - id: 9
    severity: INFO
    location: "spec.md FR-9"
    title: "工具描述中应明确说明 sync 超时后的 AI 行为引导"
    status: resolved
    raised_in_round: 1
    resolved_in_round: 2
    resolution: "FR-9 #1 已加粗强调：「重要：超时后进程仍在运行，不要重新执行同一命令，应使用 pollJobId 查询」。"

  # ===== Round 2 新发现 =====
  - id: 10
    severity: LOW
    location: "spec.md FR-1 命令前缀"
    title: "settings.json 中 shellCommandPrefix 字段名可能有误"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    detail: |
      spec 说「从 Pi settings 文件读取 shellCommandPrefix 字段」。经验证 Pi SettingsManager 确实有 shellCommandPrefix 属性（settings-manager.d.ts:72, settings-manager.js:547-551）。但当前用户的 settings.json 中不存在此字段（扩展应 fallback 为不注入，spec 已覆盖此场景：「字段不存在时不注入」）。
      
      低风险：字段名一致，fallback 行为正确。唯一关注点是扩展直接用 fs.readFileSync 读取 settings.json 需要自行处理 JSON 解析和字段缺失。FR-10 已覆盖「JSON 解析失败时使用默认值」，但此处是 Pi 的 settings.json 不是扩展自己的配置。建议在 plan 阶段明确：读取 Pi settings.json 也需要 try-catch + JSON parse + 字段缺失 fallback。

  - id: 11
    severity: LOW
    location: "spec.md FR-2 超时 detach"
    title: "pipe 切换到临时文件写入模式的具体实现细节有风险"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    detail: |
      FR-2 描述「将 pipe 切换到临时文件写入模式（或重新 pipe 到 WriteStream）」。这不是已证明的 API 用法——Node.js 的 child_process.stdout pipe 一旦开始消费，不能直接「切换」。实际可行的方案：
      (A) 从一开始就将 stdout/stderr pipe 到 WriteStream（通过 passthrough Transform），sync 模式同时收集内存中的数据供 onUpdate 使用。超时时停止内存收集，WriteStream 继续写入。
      (B) 使用内存 buffer 收集，超时时开始写入临时文件。
      
      不阻塞 spec——spec 正确描述了意图和约束，具体 pipe 管理是实现细节。plan 阶段需要验证方案 A 或 B 的可行性。标注为 LOW 而非 MUST FIX 是因为 subagent 扩展的 background 模式已经实现了类似的 pipe 管理。

  - id: 12
    severity: INFO
    location: "spec.md FR-1 Shell 发现"
    title: "自行实现 shell 发现需要处理 Windows 路径差异"
    status: open
    raised_in_round: 2
    resolved_in_round: null
    detail: "FR-1 提到 Windows: Git Bash → PATH bash.exe → 报错。Pi 内部 getShellConfig 还有额外逻辑（检查 process.env.ProgramFiles 下的 Git 安装路径等）。如果目标平台包含 Windows，plan 阶段需要仔细对照 bash.js 的完整逻辑。如果只支持 macOS/Linux（Pi 的主要使用平台），则简单 fallback 链足够。建议在 plan 中标注为风险点。"
---

# Spec 评审 v2

## 评审记录
- 评审时间：2026-05-30 16:00
- 评审类型：spec 评审第 2 轮（验证 MUST FIX 修复 + 新增检查）
- 评审对象：`.xyz-harness/2026-05-29-bash-async-background-extension/spec.md`（修改后版本）
- 参考文档：`CLAUDE.md`、Pi `@mariozechner/pi-coding-agent` 源码（bash.js、settings-manager.js/d.ts、extensions/types.d.ts、tool-execution.js）、subagent 扩展（spawn.ts）

---

## 第 1 轮 MUST FIX 修复验证

### Issue #1: BashOperations.exec() 超时 kill vs detach 冲突 → ✅ 已修复

**原始问题**：`BashOperations.exec()` 内部的 timeout handler 直接 `killProcessTree`，与「超时不 kill」需求根本冲突。

**修复方案**：FR-1 明确改用 `child_process.spawn` 直接管理进程生命周期。Constraints 段落确认「不使用 BashOperations.exec()」。

**验证**：
- `child_process.spawn` 在 Pi 扩展中可用（subagent/spawn.ts:15 `import { spawn } from "node:child_process"`）
- Pi 不沙箱化 `require()`（无 Module._load hook、无 wrapRequire）
- CLAUDE.md 已标注 subagent 使用 `child_process.spawn` 是「已知例外」，bash-async 同样适用

### Issue #2: getShellConfig/getShellEnv 不是公开 API → ✅ 已修复

**原始问题**：spec 引用了不存在的公开 API。

**修复方案**：FR-1 明确「参照 Pi 内部 getShellConfig 实现自行编写，约 30 行」。

**验证**：
- 确认 Pi 不导出 `getShellConfig`/`getShellEnv`（bash.js 中它们是模块内函数）
- `createLocalBashOperations` 只暴露 `exec()` 方法
- Pi bash.js 中 getShellConfig 约 20 行（shell 发现 + args 组装），getShellEnv 约 10 行（env 复制 + PATH 注入），30 行估计合理

### Issue #3: Background 模式与 BashOperations.exec() 不兼容 → ✅ 已修复

**原始问题**：`BashOperations.exec()` 是 async 方法，Promise 在进程退出后才 resolve。无法 spawn 后立即返回。

**修复方案**：与 Issue #1 同根因，改用 `child_process.spawn` 后可 spawn 不 await，立即返回 jobId。

**验证**：subagent 扩展的 background 模式已证明此模式可行（spawn.ts 中 `spawn()` 后不 await，通过 job Map 管理生命周期）。

### Issue #4: 设置读取机制不明确 → ✅ 已修复

**原始问题**：原文说通过 `tool_call` 事件读取 bash 工具的 settings，但 ToolCallEvent 不暴露其他工具的配置。

**修复方案**：FR-1 改为从 Pi settings 文件直接读取 `shellCommandPrefix` 和 `shellPath`。

**验证**：
- `~/.pi/agent/settings.json` 路径正确（settings-manager.js:38）
- `shellPath` 和 `shellCommandPrefix` 是合法字段（settings-manager.d.ts:70,72）
- 当前用户 settings.json 中不含这两个字段——spec 已覆盖：「字段不存在时不注入」/「使用默认值」
- 扩展通过 `fs.readFileSync` 读取 settings.json 可行（扩展可使用 fs，CLAUDE.md 仅限制网络/child_process，且 child_process 已有先例）

### Issue #5: sendMessage 生命周期安全 → ✅ 已修复

**原始问题**：Background job 完成回调中 `pi` 引用有效期、sendMessage 失败 fallback 未描述。

**修复方案**：FR-3 明确：(1) pi 在 session_start 闭包捕获；(2) sendMessage try-catch；(3) FR-6 补充错误不传播。

**验证**：
- `ExtensionAPI.sendMessage` 签名确认支持 `triggerTurn` 和 `deliverAs` 选项（types.d.ts）
- subagent 扩展使用完全相同的模式：`createSpawnManager(pi: ExtensionAPI)` 捕获 pi 引用，sendMessage 外包 try-catch
- FR-6 的 session_shutdown 清理逻辑合理（kill running jobs + 删临时文件）

---

## 第 1 轮 LOW/INFO 回访

### Issue #6 (LOW): setInterval + invalidate() → ✅ 已采纳

FR-8 已精确区分 sync 和 background 模式的渲染行为。内置 bash 使用 `setInterval(() => context.invalidate(), 1000)` 在 `options.isPartial` 时刷新耗时——spec 的 sync 模式描述与此一致。

### Issue #7 (LOW): 并发限制 → ✅ 已采纳

新增 FR-12（默认 10，可配置）+ AC-15 + FR-10 `maxBackgroundJobs` 字段。

### Issue #8 (INFO): 临时文件清理 → 接受为已知限制

### Issue #9 (INFO): AI 行为引导 → ✅ 已采纳

FR-9 #1 加粗强调超时后不重新执行。

---

## 第 2 轮新发现

### Issue #10 (LOW): settings.json 读取需要 try-catch

扩展直接读取 Pi 的 settings.json（非自身配置），需要自行处理 JSON 解析错误和字段缺失。FR-10 只覆盖了扩展自有配置文件的容错。建议 plan 阶段补充。

### Issue #11 (LOW): pipe 切换实现细节有风险

FR-2 的「pipe 切换到临时文件写入模式」描述了正确意图，但 Node.js 的 stdout pipe 不能直接切换。实际方案是从一开始就同时写入内存 buffer 和/或 WriteStream。这是实现细节，不阻塞 spec。

### Issue #12 (INFO): Windows shell 发现需要额外路径检查

如果支持 Windows，shell 发现逻辑需要比 FR-1 描述的更复杂（需检查 Git 安装路径等）。当前 spec 主要面向 macOS/Linux，风险可接受。

---

## Spec 质量综合评估

### 优点

1. **架构冲突彻底解决**：5 条 MUST FIX 共享的根因（BashOperations API 语义不兼容）通过统一改用 child_process.spawn 解决，方案与 subagent 扩展一致。
2. **新增能力全面**：v1 缺失的 AbortSignal（AC-5）、cwd 检查（AC-16）、配置文件容错（AC-11）、并发限制（FR-12/AC-15）均已补充。
3. **AC 覆盖完整**：17 条 AC 覆盖了正常路径、边界条件、错误路径。
4. **约束明确**：Constraints 段落清晰标注了技术选型理由（为什么不用 BashOperations、为什么自行实现 shell 发现）。
5. **与内置 bash 对齐**：shell 发现、env 组装、输出截断、非零退出码行为都明确标注了「与内置 bash 一致」。

### 可改进（不阻塞）

1. pipe 管理策略在 plan 阶段需要明确方案
2. Pi settings.json 读取的容错需要在 plan 阶段补充
3. Windows 支持范围需要在 plan 阶段确认

---

## 结论

**评审通过。**

Spec v2 彻底解决了 v1 的核心架构问题（BashOperations API 与 detach 需求的语义冲突），技术选型（child_process.spawn + 自行实现 shell 发现）经源码验证可行且与现有 subagent 扩展模式一致。2 条 LOW 和 1 条 INFO 是实现层面的细节，应在 plan 阶段处理。

**可以进入 plan 阶段。**
