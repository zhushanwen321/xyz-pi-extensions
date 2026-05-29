---
verdict: pass
must_fix: 0
reviewed_files:
  - evolution-engine/src/gc.ts
review_date: 2026-05-28
phase: 2
---

# 健壮性审查 v2：gc.ts 修复验证

## 审查目标

验证 v1 的 MUST-FIX-1（gc.ts `removeFiles` 静默吞错）是否已正确修复，以及修复是否引入新问题。

---

## 1. MUST-FIX-1 修复确认

### 状态：✅ 已修复

**v1 代码**（catch 完全为空）：
```typescript
catch {
  // 权限或并发删除导致失败，静默跳过
}
```

**当前代码**（catch 输出 warning）：
```typescript
catch (err) {
  // 文件可能已被其他进程删除，记录但不停滞
  console.warn(`[evolve-gc] Failed to remove ${p}: ${err instanceof Error ? err.message : String(err)}`);
}
```

修复内容：

1. **`catch {}` → `catch (err)`**：捕获错误对象，不再静默。
2. **`console.warn(...)`**：输出错误消息，包含文件路径和原因。使用 `console.warn`（而非 `console.log`/`console.error`）是合理的——GC 是后台操作，文件删除失败是需要注意但不致命的场景。
3. **`err instanceof Error ? err.message : String(err)`**：正确处理 `unknown` 类型，防御了非 Error 类型的 throw。
4. **注释说明清晰**：解释了失败的可能原因（并发删除）和当前行为（记录但不停滞）。

评价：修复正确且适当。没有过度日志（每条失败路径一条 warning），没有改变控制流（失败时仍继续处理剩余文件）。

---

## 2. 新引入问题检查

### 无新引入问题

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 类型安全 | ✅ 通过 | `catch (err)` 的 `unknown` 类型用 `instanceof` 守卫正确处理 |
| 变量作用域 | ✅ 通过 | `err` 只在 catch 块内使用，未泄漏 |
| 控制流变更 | ✅ 通过 | catch 块执行后仍 `continue` 循环，未引入 break/return |
| 日志无侵入 | ✅ 通过 | `console.warn` 带 `[evolve-gc]` 前缀，可 grep 过滤 |
| 无敏感信息泄露 | ✅ 通过 | 仅输出路径和错误消息，无堆栈或内存内容 |
| 类型检查 | ✅ 通过 | `npx tsc --noEmit` 无错误 |

---

## 3. 残留问题（v1 已识别，本次未涉及）

以下问题在 v1 中已识别，但不在 gc.ts 修复范围内：

| # | 问题 | 文件 | 严重程度 | 状态 |
|---|------|------|---------|------|
| S-3 | `runGc()` 返回值被丢弃 | `commands.ts:176` | 中 | 未修复（在 commands.ts） |
| N-6 | `listJsonByMtime` / `listExpiredDaily` catch 仍静默返回 `[]` | `gc.ts:39,87` | 低 | 未修复 |

### N-6 补充说明

`listJsonByMtime`（line 39）和 `listExpiredDaily`（line 87）的 catch 块仍然是空的：

```typescript
} catch {
  return [];
}
```

这是 v1 已识别的 NTH-6。当前行为是 **有意为之** 的防御性设计——`runGc` 的文档注释明确说"目录不存在时静默跳过，不报错"，调用方 `commands.ts` 也不期望 GC 因读目录错误而崩溃。然而，与 `removeFiles` 不同，这里 catch 的错误原因不可观测：

- 是目录不存在（正常）？
- 还是权限错误（需要管理员注意）？
- 还是文件系统损坏（严重）？

**建议**：如果改为 `console.warn` 级别太低（正常场景也会触发），可按以下逻辑降噪：

```typescript
} catch (err: unknown) {
  // 目录不存在是正常情况，跳过；其他错误记录 warning
  if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    // 目录不存在，跳过
  } else {
    console.warn(`[evolve-gc] Failed to list ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

这样既避免了正常场景的噪音，又能捕获异常错误。**但这不在本次 MUST FIX 范围内**，属于可选的增量改进。

---

## 4. 综合评价

| 维度 | 状态 |
|------|------|
| v1 MUST-FIX 修复 | ✅ 全部完成 |
| 新引入问题 | ✅ 无 |
| 类型安全 | ✅ 通过 |
| 运行时健壮性 | ✅ 通过 |

修复后 `removeFiles` 在失败时输出 `[evolve-gc] Failed to remove <path>: <reason>` warning，消除了 v1 中"最严重的调试友好问题"。GC 模块整体健壮性已满足投产标准。

**结论：第 1 轮 MUST-FIX-1 已正确修复，没有新问题引入。健壮性审查通过。**
