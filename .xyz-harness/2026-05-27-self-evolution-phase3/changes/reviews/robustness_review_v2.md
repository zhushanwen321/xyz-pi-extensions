---
verdict: pass
must_fix: 0
review_metrics:
  files_reviewed: 3
  v1_must_fix: 2
  v1_must_fix_resolved: 2
  new_issues: 1
  review_depth: v1_mf_verification + fix_regression
---

# Evolution Engine — 健壮性审查 V2（MUST_FIX 回归验证）

**审查范围**：`evolution-engine/src/applier.ts`、`evolution-engine/src/commands.ts`、`evolution-engine/src/types.ts`  
**审查日期**：2026-05-27  
**审查目标**：验证 V1 报告的 2 项 MUST_FIX 是否修复、修复是否引入新问题

---

## MF1. 备份路径不一致导致回滚必然失败

**状态：✅ 已修复**

### 验证过程

V1 指出 `handleEvolveApply()` 在记录 history 时写入的 `backupPath` 是自行拼接的假路径 `join(backupDir, \`${suggestion.id}.bak\`)`，而实际备份路径是 `backupDir/<timestamp>/<basename>`。

**修复后链路**：

| 环节 | 修复前 | 修复后 |
|------|--------|--------|
| `applySuggestion()` 返回值 | `{ success, reason }` | `{ success, reason?, backupPath, commitSha }` |
| `ApplyResult` 接口 | 无 `backupPath` 字段 | 新增 `backupPath?: string` |
| `handleEvolveApply()` history 记录 | `join(backupDir, \`${suggestion.id}.bak\`)` | `result.backupPath ?? join(backupDir, \`${suggestion.id}.bak\`)` |
| `HistoryEntry` 接口 | — | 已有 `backupPath: string`（必要字段） |
| `HistoryEntry.title` | 缺少（V1 未提及但必要） | 已增加 `title: string`（必要字段） |
| `HistoryEntry.commitSha` | 缺少（V1 未提及但必要） | 已增加 `commitSha?: string`（可选字段） |

**关键检查点**：
1. `types.ts` 的 `ApplyResult` 已新增 `backupPath?: string` ✅
2. `applier.ts` 的 `applySuggestion()` 返回 `{ success: true, backupPath, commitSha }`，`backupPath` 来自 `backupFile()` 的真实路径 ✅
3. `rollbackSuggestion()` 已可读取 `entry.backupPath` 的正确备份路径 ✅
4. `history` 记录时 `??` 后的 fallback 路径仅在 `result.backupPath` 为 `undefined` 时生效（当前代码不会命中，因为成功路径必定有 `backupPath`）✅

**回归风险**：无。改动范围精准，仅在 `ApplyResult` 增加字段 + 消费方使用正确的 `result.backupPath`。不影响其他调用方。

---

## MF2. execSync 嵌入用户可控字符串导致 Shell 命令注入风险

**状态：✅ 已修复**

### 验证过程

V1 指出 `applier.ts` 中两处 `execSync` 将 suggestion title 嵌入 shell 命令字符串，存在任意代码执行风险。

**修复方式**：`execSync` → `execFileSync`（参数数组模式，不经 shell 解释）

| 文件 | 函数 | 操作 | 修复方式 |
|------|------|------|----------|
| `applier.ts` | `applySuggestion()` | `git commit -m` | `execFileSync("git", ["commit", "-m", \`evolve: ${suggestion.title}\`], ...)` |
| `applier.ts` | `rollbackSuggestion()` | `git commit -m` | `execFileSync("git", ["commit", "-m", \`evolve: rollback ${entry.title}\`], ...)` |
| `applier.ts` | `applySuggestion()` | `git add` | `execFileSync("git", ["add", suggestion.targetPath], ...)` |
| `applier.ts` | `rollbackSuggestion()` | `git add` / `git revert` | `execFileSync("git", [...], ...)` |
| `applier.ts` | `applySuggestion()` | `git rev-parse` | `execFileSync("git", ["rev-parse", "HEAD"], ...)` |

**关键检查点**：
1. `import { execFileSync }` 替代 `import { execSync }` ✅
2. 所有 git 调用均以参数数组形式传递，标题/路径作为独立数组元素 ✅
3. `suggestion.title`/`entry.title` 中的 `$`、反引号、`;`、`|`、`\\`、`\n` 等 shell 元字符不再有解释机会 ✅
4. `applier.ts` 中不再有任何 `execSync` 调用 ✅

**回归风险**：无。`execFileSync` API 签名与 `execSync` 不同（第一个参数是可执行路径而非命令字符串），但当前改动正确传递了 `"git"` 作为可执行文件路径。`cwd` 和 `stdio` 选项在两者间兼容。

---

## 修复引入的新问题检查

逐行检查了 `applier.ts`、`commands.ts`、`types.ts` 的变更，**未发现修复本身引入的新问题**。

### 变更影响范围

**`types.ts`**：
- `ApplyResult` 新增 `backupPath?` 和 `commitSha?` — 可选字段，不影响现有消费者
- 所有新增字段均被消费方正确使用（`commands.ts` 读 `result.backupPath`，`applier.ts` 写 `backupPath`、`commitSha`）

**`applier.ts`**：
- 导入从 `execSync` 切到 `execFileSync` — 行为等价，安全性提升
- `backupPath` 返回值直接透传 — 链路完整

**`commands.ts`**：
- `backupPath: result.backupPath ?? join(backupDir, \`${suggestion.id}.bak\`)` — `??` 语义正确（`undefined`/`null` 时 fallback，空字符串 `""` 不会 fallback，但 `backupPath` 不会是空字符串）

---

## 新发现：V1 遗漏的 shell 注入风险（LOW）

V1 的 MF2 仅覆盖了 `applier.ts`，但 `commands.ts` 中 `handleEvolve()` 有一条类似的 `execSync` 调用未被排查：

```typescript
// commands.ts:119
execSync(
    `python3 "${ANALYZER_SCRIPT}" --since ${params.since} --format json --output "${tmpReportPath}"`,
    { timeout: ANALYZER_TIMEOUT_MS, stdio: "pipe" },
);
```

**问题**：`params.since` 是用户提供的字符串，直接模板插值到 shell 命令中。虽然 `parseSinceDays()` 进行了解析，但并未对原始字符串做 sanitization——它只是提取数字部分（或返回默认值 7），但不阻止原始字符串中的恶意 payload 被 shell 执行。

**示例**：用户执行 `/evolve since=7d;rm -rf ~` 时，`params.since` 为 `7d;rm -rf ~`，`execSync` 通过 `/bin/sh -c` 执行完整字符串。

**影响评估**：
- 攻击链路：Pi 命令行参数 → `params.since` → shell 拼接 → 任意命令执行
- `ANALYZER_SCRIPT` 为硬编码常量，安全
- `tmpReportPath` 由 `dirs.reportsDir` + `Date.now()` 拼接，安全

**建议**：
1. 将此处的 `execSync` 改为 `execFileSync("python3", [...args])`，将参数作为数组传递
2. 或至少在插值前对 `params.since` 做正则校验（如 `/^\d+d$/`）

```typescript
// 方案一（推荐）：execFileSync
execFileSync("python3", [
    ANALYZER_SCRIPT,
    "--since", params.since,
    "--format", "json",
    "--output", tmpReportPath,
], { timeout: ANALYZER_TIMEOUT_MS, stdio: "pipe" });

// 方案二（防护）：提前校验
if (!/^\d+d$/.test(params.since)) {
    throw new Error(`Invalid since format: "${params.since}". Expected like "7d".`);
}
```

---

## 结论

| 项目 | 结果 |
|------|------|
| MF1（备份路径不一致） | ✅ 已修复 — 使用 `result.backupPath` 传递真实路径 |
| MF2（execSync shell 注入） | ✅ 已修复 — 替换为 `execFileSync` 参数数组模式 |
| 修复引入的新问题 | ❌ 无 |
| V1 遗漏项 | ⚠️ `commands.ts` `handleEvolve()` 仍有 `execSync` 通过 `params.since` 拼接 shell 命令，属同类 shell 注入风险 |

**verdict: pass** — V1 的 2 项 MUST_FIX 均已正确修复，未引入新问题。`commands.ts` 中发现的 shell 注入遗漏项建议合并前处理，或单独开 issue 跟踪。
