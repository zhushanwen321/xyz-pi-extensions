---
verdict: fail
must_fix: 2
review_metrics:
  files_reviewed: 8
  issues_found: 17
  must_fix_count: 2
  low_count: 11
  info_count: 4
---

# Evolution Engine — 健壮性审查报告

**审查范围**：evolution-engine Extension 全部 8 个源文件  
**审查日期**：2026-05-27  
**审查维度**：错误处理 / 异常 / 日志 / Fail-fast / 测试友好 / 调试友好  
**文件清单**：
| # | 文件 | 行数 | 职责 |
|---|------|------|------|
| 1 | `src/types.ts` | 117 | 类型定义 |
| 2 | `src/state.ts` | 82 | 持久化（pending.json / history.jsonl） |
| 3 | `src/judge.ts` | 214 | LLM Judge 子进程编排 |
| 4 | `src/applier.ts` | 197 | 建议应用引擎（diff apply / rollback） |
| 5 | `src/monitor.ts` | 266 | 自动触发规则监控 |
| 6 | `src/commands.ts` | 379 | Command handler 函数 |
| 7 | `src/index.ts` | 263 | Extension 工厂 |
| 8 | `src/widget.ts` | 126 | TUI 渲染函数 |

---

## MUST_FIX（2 项）

### MF1. 备份路径不一致导致回滚必然失败

**文件**：`src/commands.ts`（handleEvolveApply）+ `src/applier.ts`（applySuggestion / backupFile）  
**维度**：错误处理 / 异常  
**严重程度**：rollback 功能完全不可用

**问题描述**：
`applySuggestion()` 调用 `backupFile()`，实际备份路径为 `<backupDir>/<ISO-timestamp>/<basename>`（包含时间戳子目录）。但 `handleEvolveApply()` 在记录 history 时，写入的 `backupPath` 却是自行拼接的假路径：

```typescript
// commands.ts — handleEvolveApply
appendHistory(dirs.evolutionDir, {
    // ...
    backupPath: join(backupDir, `${suggestion.id}.bak`),  // ← 假路径
    // ...
});
```

而 `rollbackSuggestion()` 直接读取 `entry.backupPath` 做 `existsSync` 检查：

```typescript
// applier.ts — rollbackSuggestion
if (!fs.existsSync(entry.backupPath)) {
    return { success: false, reason: "backup file not found" };
}
```

**影响**：所有已 apply 的 suggestion 无法 rollback。用户执行 `/evolve-rollback` 时会始终收到 "backup file not found"。

**修复方案**：修改 `applySuggestion()` 的返回值 `ApplyResult`，增加可选的 `backupPath` 字段；或修改 `appendHistory` 逻辑，写入真实的备份路径。

```typescript
// ApplierResult 增加 backupPath
export interface ApplyResult {
    success: boolean;
    reason?: string;
    backupPath?: string;  // 新增
}
```

---

### MF2. execSync 嵌入用户可控字符串导致 Shell 命令注入风险

**文件**：`src/applier.ts`（applySuggestion / rollbackSuggestion）  
**维度**：异常 / 安全  
**严重程度**：任意代码执行风险

**问题描述**：
两处 `execSync` 将 suggestion title 直接嵌入 git commit 命令字符串，仅转义了双引号：

```typescript
// applySuggestion
const escapedTitle = suggestion.title.replace(/"/g, '\\"');
execSync(`git commit -m "evolve: ${escapedTitle}"`, {
    cwd: dirName, stdio: "pipe",
});

// rollbackSuggestion（相同模式）
execSync(`git commit -m "evolve: rollback ${escapedTitle}"`, {
    cwd: dirName, stdio: "pipe",
});
```

`escapedTitle` 只处理了 `"`，但 `$`、反引号、`;`、`|`、`\`、`\n` 等 shell 元字符均未处理。如果 LLM Judge 产出的 `title` 包含恶意内容（如 `foo; rm -rf ~/.pi;`），则 `execSync` 会通过 `/bin/sh -c` 执行任意命令。

**影响**：攻击向量间接（需控制 LLM Judge 输出），但一旦触发后果严重。

**修复方案**：改用 `execFileSync`（不经过 shell），传入参数数组：

```typescript
import { execFileSync } from "node:child_process";

// 替代 execSync
execFileSync("git", ["commit", "-m", `evolve: ${suggestion.title}`], {
    cwd: dirName, stdio: "pipe",
});
```

`execFileSync` 直接执行 git 可执行文件，参数作为独立数组传递，shell 元字符不再有解释机会。

---

## LOW（11 项）

### L1. extractAssistantText 静默返回空字符串

**文件**：`src/judge.ts`  
**维度**：调试友好

当 `pi --mode json` 的 JSONL 输出格式变化（如 event type 从 `message_end` 改为其他结构），`extractAssistantText()` 会静默返回空字符串 `""`，不产生任何警告或日志。后续 `parseJudgeOutput()` 收到空字符串后抛出 "Empty Judge output"，错误信息对问题根因无提示。

建议：在 find 失败时增加一条 warn 日志或附加诊断信息，区分"无输出"和"格式不匹配"。

---

### L2. 无 Judge 执行日志

**文件**：`src/judge.ts`（runJudge）  
**维度**：日志 / 调试友好

`runJudge()` 是核心操作（spawn 子进程调用 LLM），但没有记录开始时间、结束时间、消耗的 token 数、子进程退出码等关键信息。当 Judge 耗时过长或意外失败时，难以定位问题阶段。

建议：在 spawn 前输出 `[judge] start` 日志，完成后输出 `[judge] done (status=X, suggestions=N)`。

---

### L3. parseUnifiedDiff 不处理 `@@ -0,0 +1,N @@`（空文件创建）hunk

**文件**：`src/applier.ts`（parseUnifiedDiff）  
**维度**：错误处理

正则 `@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@` 中，`oldLines` 和 `newLines` 的默认值为 1。对于空文件创建场景，hunk 为 `@@ -0,0 +1,5 @@`，`oldLines = 0, newLines = 5`。默认值 1 导致解析偏差：`oldCount` 会多要求读 1 行，可能导致 hunk 边界错位或吞掉后续 hunk。

建议：检查 `@@` 匹配后的 `hunkMatch[2]` 和 `hunkMatch[4]` 是否存在未定义的情况，未定义时才设默认值 1。

---

### L4. TEMPLATE_DIR 降级路径假设脆弱

**文件**：`src/index.ts`  
**维度**：异常

```typescript
const TEMPLATE_DIR = (() => {
    try {
        return join(dirname(fileURLToPath(import.meta.url)), "templates");
    } catch {
        return join(process.cwd(), "evolution-engine", "src", "templates");
    }
})();
```

catch 块注释称"理论上不会执行"，但降级路径 `join(process.cwd(), "evolution-engine", "src", "templates")` 假设了：
1. Pi 的 cwd 必然是 workspace 根目录（`xyz-pi-extensions-workspace`）
2. 扩展目录名一定是 `evolution-engine`

如果 Pi 从用户项目目录启动或在 bundler 环境中 `import.meta.url` 不可用，此降级路径会指向错误的目录，导致 `runJudge()` 找不到模板文件而抛出 "Judge template not found"。

建议：用 `fileURLToPath(import.meta.url)` + 循环向上查找 `package.json` 的方式定位扩展根目录，而非依赖 cwd。

---

### L5. state.ts 文件操作无日志

**文件**：`src/state.ts`（loadPending / savePending / appendHistory / loadHistory）  
**维度**：日志

所有文件读写操作（创建、写入、追加）均无日志。当并发或竞争条件导致写失败时，无法从日志中排查。例如 `loadHistory` 中的损坏行静默跳过（内层 catch 块），无任何记录。

建议：对关键操作（writeFileSync / appendFileSync / 损坏行跳过）增加 `console.warn` 或日志输出。

---

### L6. applier.ts 无操作日志

**文件**：`src/applier.ts`（applySuggestion / rollbackSuggestion / git commit）  
**维度**：日志

备份路径的生成、diff 应用、git commit 结果均无日志。当 apply 静默失败（如 git 在 detached HEAD 状态）时，只能通过返回结果判断，无历史可追溯。

---

### L7. sample 参数定义但未使用

**文件**：`src/commands.ts`（EvolveCommandParams / handleEvolve）  
**维度**：测试友好

```typescript
export interface EvolveCommandParams {
    target: "all" | "claude-md" | "skills";
    since: string;
    sample: number | undefined;  // ← 未使用
}
```

参数定义在 schema 中也注册了 `sample`，但在 `handleEvolve` 逻辑中从未引用。这可能误导用户或调用方以为可以控制采样数量。

建议：移除该参数，或补充实现。

---

### L8. findRecentReport 遍历并 stat 所有文件

**文件**：`src/commands.ts`（findRecentReport）  
**维度**：性能

每次调用 `handleEvolve` 都通过 `readdirSync` 遍历 `reportsDir` 下所有 `.json` 文件并对每个文件做 `statSync`。随着报告累积，此操作会成为不必要的 I/O 开销。

建议：使用文件名中的日期前缀过滤，或在文件系统中缓存最近报告路径；若有大量文件，改用 `readdirSync` + 名称正则匹配而非全量 stat。

---

### L9. monitor.ts 规则触发无日志

**文件**：`src/monitor.ts`（checkAutoTriggerRules）  
**维度**：日志

三条自动触发规则（token-decline / skill-dormant / error-spike）的命中、冷却跳过、flag 清理均无日志。用户无法知道某个 flag 为何被触发或何时被清理。

建议：每条规则命中时输出 `[monitor] rule=X hit: detail`，冷却跳过时输出 `[monitor] rule=X skipped (cooling)`。

---

### L10. session_start 同步 I/O 可能阻塞会话启动

**文件**：`src/index.ts`（session_start handler）  
**维度**：异常

```typescript
pi.on("session_start", async (_event, ctx) => {
    const flags = checkAutoTriggerRules(dirs.evolutionDir);
    cleanExpiredFlags(dirs.evolutionDir);
    // ...
});
```

`checkAutoTriggerRules()` 内部执行若干同步文件 I/O 操作（readdirSync / readFileSync / statSync），包括遍历 daily 目录下所有文件、解析 JSON。在会话启动的关键路径上执行同步 I/O，若 evolution-data 积累了较多文件，可能延迟会话启动。

建议：考虑将监控检查延迟到进程空闲时执行（如 `setImmediate`），或使用异步 I/O 版本。

---

### L11. backupFile 无返回值的校验

**文件**：`src/applier.ts`（backupFile）  
**维度**：错误处理

`backupFile()` 内部使用 `copyFileSync` 复制文件，但如果源文件在复制过程中被删除或读取权限不足，`copyFileSync` 会抛出异常。而调用方 `applySuggestion` 中无 try-catch 保护 `backupFile` 调用——异常会直接穿透到 handler 层。

```typescript
// applier.ts — applySuggestion
const backupPath = backupFile(suggestion.targetPath, backupDir);  // ← 无 try-catch
// ...
const result = applyUnifiedDiff(suggestion.targetPath, suggestion.diff);
// ...
```

建议：`backupFile` 内部用 try-catch 包裹 `copyFileSync`，失败时抛出带有文件路径和错误信息的异常。

---

## INFO（4 项）

### I1. isPathAllowed 严格限制 `.md` 文件

**文件**：`src/applier.ts`  
**维度**：—

当前白名单要求路径在 `~/.pi/agent/` 下且以 `.md` 结尾。这意味着：
- `skill` 类型的建议（可能修改非 `.md` 文件）会被阻止
- 设计上安全但限制了扩展性

建议在未来支持更多文件类型时测试 `isPathAllowed` 的覆盖范围。

### I2. loadRecentDaily 每次全量遍历 daily 目录

**文件**：`src/monitor.ts`  
**维度**：性能

每次 `checkAutoTriggerRules()` 调用都遍历 `daily/` 目录下所有文件并解析 JSON。高频调用场景下（如多次 session_start）可考虑缓存最近结果。

### I3. JSONL 解析无大小保护

**文件**：`src/judge.ts`（extractAssistantText）  
**维度**：—

`stdout.split("\n")` 针对巨量输出（如几十万行 JSONL）会导致 OOM。当前场景下概率低，但属于长尾风险。建议在 loop 中加入行数上限。

### I4. parseUnifiedDiff 仅支持 unified 格式

**文件**：`src/applier.ts`（parseUnifiedDiff）  
**维度**：—

当前实现只处理标准 unified diff 格式。如果 LLM Judge 产出其他格式的 diff（如 git format-patch 或上下文 diff），解析会失败。项目意图明确只支持 unified 格式，此处仅做记录。

---

## 各维度汇总

| 维度 | MUST_FIX | LOW | INFO | 评述 |
|------|----------|-----|------|------|
| ① 错误处理 | 2 | 3 | 0 | 备份路径断裂是架构级错误；execSync 注入可修复 |
| ② 异常 | 0 | 2 | 0 | 同步 I/O 阻塞会话启动需关注；backupFile 缺保护 |
| ③ 日志 | 0 | 5 | 0 | 最大短板——核心操作（judge、apply、monitor）均无日志 |
| ④ Fail-fast | 0 | 2 | 0 | findRecentReport 无 fast-path；parseUnifiedDiff 空文件 hunk 缺校验 |
| ⑤ 测试友好 | 0 | 1 | 0 | 纯函数分离好（widget/state），但 applier/commands 紧耦合 |
| ⑥ 调试友好 | 0 | 2 | 0 | extractAssistantText 静默失败；无 judge 执行记录 |

**正面发现**：
- `parseJudgeOutput()` 对 LLM 输出做了全面的字段校验（必填字段、enum 检查、范围检查），是优秀实践
- `monitor.ts` 的 cooldown 机制避免了重复触发
- `widget.ts` 全部为纯函数，测试友好性高
- `state.ts` 对文件损坏有容错处理（null 返回、损坏行跳过）

---

## 结论

**verdict: fail** — 2 项 MUST_FIX 需要在合并前修复：

1. **MF1**（备份路径不一致）直接导致 rollback 功能不可用，属功能性缺陷
2. **MF2**（execSync shell 注入）虽攻击链路间接，但修复简单且属于编码安全意识问题

建议修复顺序：MF1 → MF2 → 其余 LOW 项按需处理（日志项可单独立 issue）。
