---
verdict: fail
must_fix: 3
---

# 代码评审报告

**评审版本**: `HEAD~1..HEAD` (commit 包含 3 个文件变更: commands.ts, config-loader.ts, index.ts)

**评审范围**: `workflow/src/` — FR1–FR6 的 Ad-hoc Workflow Generation 实现

**评审维度**: Spec 合规, 代码质量, 架构合规, 安全/性能

---

## 1. Spec 合规检查

### FR1: `/workflow <prompt>` 智能路由

| 要求 | 状态 | 说明 |
|------|------|------|
| FR1.1 调用 config-loader 获取 workflow 列表后通过 sendUserMessage 传回 AI | ✅ | default handler 调用 `loadWorkflows()` 并序列化为文本列表 |
| FR1.2 AI 收到后可判断匹配/复用/新建 | ✅ | sendUserMessage 内容包含 + 匹配指令 |
| FR1.3 执行前必须展示路径并等待确认 | ✅ | tool description + execute 返回值 + promptGuidelines 三重提醒 |

### FR2: `workflow-generate` Tool

| 要求 | 状态 | 说明 |
|------|------|------|
| FR2.1 name/script/description 参数 | ✅ | Type.Object 定义完整 |
| FR2.2 meta 导出验证 | ✅ | 检查 `const meta` / `export const meta` / `module.exports = { meta` |
| FR2.2 name 冲突检查 | ✅ | 调用 `loadWorkflows()` + throw |
| FR2.2 语法校验 `new Function` | ✅ | |
| FR2.2 自动创建 .tmp 目录 | ✅ | `mkdirSync(..., { recursive: true })` |
| FR2.2 写入文件 | ✅ | `writeFileSync` |
| FR2.3 AI 展示路径+等待确认 | ✅ | execute 返回值包含提示 |

### FR3: `/workflow save` 命令

| 要求 | 状态 | 说明 |
|------|------|------|
| FR3.1 save <tmp-name> | ✅ | saveWorkflow 实现 |
| FR3.2 --as <new-name> | ✅ | parts.indexOf("--as") 解析 |
| FR3.3 目标已存在时拒绝 | ✅ | accessSync 检查后 throw |
| FR3.4 保存不影响运行中 Worker | ✅ | renameSync 原子操作，不接触 Worker |
| FR3.5 仅保存到 `.pi/workflows/` | ✅ | SAVED_DIR 硬编码为 `.pi/workflows` |

### FR4: 临时 workflow 存储

| 要求 | 状态 | 说明 |
|------|------|------|
| FR4.1 .tmp/ 子目录存放 | ✅ | |
| FR4.2 不自动删除 | ✅ | 无 cleanup 逻辑 |
| FR4.3 扫描覆盖 3 个目录 | ✅ | 新增 tmpDir 扫描 |
| FR4.4 source 标记 | ✅ | scanDirectory 接受 source 参数 |
| FR4.5 同名去重优先级 | ✅ | Map 低→高插入顺序覆盖 |

### FR5: `/workflow list` 展示增强

| 要求 | 状态 | 说明 |
|------|------|------|
| FR5.1 [source] 标签 | ✅ | 格式 `[${wf.source}] ${wf.name} — ${wf.description}` |
| FR5.2 显示 name + description | ✅ | |

### FR6: `/workflows` 交互面板增强

| 要求 | 状态 | 说明 |
|------|------|------|
| FR6.1 [tmp]/[saved] 标签 | ❌ | **未实现** — widget.ts 无变更 |
| FR6.2 Run/Save/Delete 操作 | ❌ | **未实现** — widget.ts 无变更 |
| FR6.3 运行中拒绝删除 | ❌ | deleteWorkflow 函数已存在 commands.ts 但 widget 未调用 |

**结论**: FR6 完全未实现。5 项 FR 中 4 项通过，1 项缺失。

---

## 2. 必须修复的问题 (must_fix)

### 🔴 MF1: `saveWorkflow` 文件存在性检查使用 try/catch 而非 `existsSync`

**文件**: `workflow/src/commands.ts:447-456`

**代码**:
```typescript
try {
  accessSync(destPath);
  throw new Error(`'${destName}' already exists in saved workflows. Use --as to save with a different name.`);
} catch (err: unknown) {
  if (err instanceof Error && err.message.includes("already exists")) {
    throw err;
  }
  // accessSync threw because file doesn't exist — proceed
}
```

**问题**: 使用 `accessSync` 的异常抛出来判断文件是否存在。如果 `accessSync` 失败不是因为 ENOENT（文件不存在）而是由于权限错误（EACCES），catch 块会将其误判为"文件不存在"并继续执行后续的 `renameSync`。而 `renameSync` 也会因权限错误失败，此时用户看到的错误信息是混乱的。

该模式本质上是"用异常流做控制流"，且存在真实的分支误判风险。

**修复方案**: 改用 `existsSync`:
```typescript
if (existsSync(destPath)) {
  throw new Error(`'${destName}' already exists in saved workflows. Use --as to save with a different name.`);
}
// 文件不存在，继续保存
```

---

### 🔴 MF2: config-loader 去重逻辑丢弃了不可用 (available=false) 的 workflow

**文件**: `workflow/src/config-loader.ts:222-241`

**旧代码** (保留全部 workflow，含不可用的):
```typescript
const seen = new Set<string>();
const merged: CachedWorkflowMeta[] = [];
for (const wf of projectWorkflows) {
  seen.add(wf.name);
  merged.push(wf);
}
for (const wf of userWorkflows) {
  if (!seen.has(wf.name)) {
    seen.add(wf.name);
    merged.push(wf);
  }
}
```

**新代码** (仅保留 available === true 的):
```typescript
for (const wf of userWorkflows) {
  if (wf.available) mergedMap.set(wf.name, wf);
}
for (const wf of projectWorkflows) {
  if (wf.available) mergedMap.set(wf.name, wf);
}
for (const wf of tmpWorkflows) {
  if (wf.available) mergedMap.set(wf.name, wf);
}
```

**问题**: 原来无法加载的 workflow 脚本会在列表中以 `available: false` 显示，帮助用户/开发者诊断加载失败的原因。新代码静默过滤掉了所有不可用 workflow，使得加载错误完全不可见。这是一个功能回退。

**修复方案**: 保留 unavailable workflow 但标记正确的 source。可以在 `mergedMap` 中设置时优先保留 available 的，如果当前不存在该 name 则保留 unavailable 的（用优先级高的 source）:
```typescript
for (const wf of userWorkflows) {
  if (wf.available || !mergedMap.has(wf.name)) mergedMap.set(wf.name, wf);
}
for (const wf of projectWorkflows) {
  if (wf.available || !mergedMap.has(wf.name)) mergedMap.set(wf.name, wf);
}
for (const wf of tmpWorkflows) {
  if (wf.available || !mergedMap.has(wf.name)) mergedMap.set(wf.name, wf);
}
```

---

### 🔴 MF3: FR6 (widget 面板) 完全未实现

**文件**: `workflow/src/widget.ts` — 零改动

**问题**: 根据 spec:
- FR6.1: 交互面板显示 `[tmp]`/`[saved]` 标签区分来源
- FR6.2: 选中 workflow 后显示 Run/Save(仅 tmp)/Delete 操作选项
- FR6.3: Delete 前检查 workflow 是否在运行

以上功能在 widget.ts 中均未实现。`commands.ts` 中已导出的 `deleteWorkflow` 和 `saveWorkflow` 函数表明这些函数是为 widget 准备的（见 spec 和 plan 的 G3），但实际未接入。

注意: `commands.ts` 的 `/workflows` 命令未修改（仍使用 `orch.list()` 显示运行实例，不显示可用脚本），`widget.ts` 的 `renderWorkflowList` 也未修改。

**修复方案**: 按 plan Task 4 实现:
1. `renderWorkflowList` 中根据 `source` 字段显示 `[tmp]`/`[saved]` 标签
2. 面板中增加 `s`/`d` 快捷键调用 `saveWorkflow`/`deleteWorkflow`
3. `deleteWorkflow` 调用前检查 running 实例

---

## 3. 次要问题 (should fix)

### 🟡 S1: import 顺序不符合项目规范

**文件**: `workflow/src/commands.ts`, `workflow/src/index.ts`

**问题**: CLAUDE.md 要求 import 顺序为 "Node 内置 → npm 包 → 项目内部"，但现有代码中 `@mariozechner/pi-coding-agent`（npm 包）出现在 `node:fs`/`node:path`（Node 内置）之前。

**示例 (commands.ts)**:
```typescript
// npm 包 (应先放)
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
// Node 内置 (应在前)
import { renameSync, mkdirSync, accessSync, existsSync, unlinkSync } from "node:fs";
```

**影响**: 品味检查 (taste-lint) 未配置此规则，不阻塞 CI，但违反项目约定。建议修复以保持一致性。

---

### 🟡 S2: `deleteWorkflow` 不支持用户级 workflow 删除

**文件**: `workflow/src/commands.ts:489-511`

**问题**: `deleteWorkflow` 只检查 `.pi/workflows/.tmp/` 和 `.pi/workflows/`，不检查 `~/.pi/agent/workflows/`。虽然 FR3.5 决定不操作用户级目录，但 `deleteWorkflow` 是通用工具函数，当用户输入用户级 workflow 名称时会返回"not found"错误，不够直观。

**影响**: 轻微。与 spec 决策一致，但可考虑在错误信息中提示用户级 workflow 需手动管理。

---

## 4. 代码质量分析

### 类型安全

| 项 | 评价 |
|------|------|
| `any` 类型使用 | ✅ 无 `any`，全部使用 `unknown` 或具体类型 |
| `WorkflowSource` 类型 | ✅ 定义为 `"saved" | "tmp"` 字符串枚举 |
| `CachedWorkflowMeta.source` | ✅ 类型正确继承 |
| 类型断言 | ✅ 仅在 `_ctx` 等必要处使用 `as`，无风险模式 |

### 错误处理

| 场景 | 评价 |
|------|------|
| `saveWorkflow` 源文件不存在 | ✅ 通过 `loadWorkflows()` 查找，找不到则 throw |
| `saveWorkflow` 目标文件已存在 | ⚠️ 见 MF1 — 使用 try/catch 而非 existsSync |
| `saveWorkflow` renameSync 失败 | ✅ 自然 throw，由命令 handler catch 后显示 |
| `deleteWorkflow` running 检查 | ✅ 回调注入，上层判断 |
| `workflow-generate` 语法错误 | ✅ new Function 抛异常转为 throw Error |
| `workflow-generate` name 冲突 | ✅ loadWorkflows 查找发现冲突后 throw |
| `loadWorkflows` 目录不存在 | ✅ scanDirectory 中 access 失败返回空数组 |
| `list` 的 `loadWorkflows` 调用 | ✅ try/catch 忽略错误，回退到只显示运行实例 |

### 边界情况

| 场景 | 评价 |
|------|------|
| `--as` 参数后无值 | ✅ `parts[asIdx + 1]` 验证 |
| `.tmp/` 目录不存在 | ✅ `mkdirSync({ recursive: true })` 自动创建 |
| 空的 workflow 列表 | ✅ `workflows.length > 0` 检查，否则跳过 |
| 空的工作目录 | ✅ `scanDirectory` 返回空数组 |
| 并发 `saveWorkflow` 调用 | ⚠️ `accessSync` + `renameSync` 非原子操作，竞态时可能损坏。但 save 命令的是串行用户操作，风险可接受 |

---

## 5. 架构合规性

| 原则 | 遵守情况 | 说明 |
|------|---------|------|
| 禁止 `any` | ✅ | 严格遵守 |
| import 顺序 | ❌ | 见 S1 |
| Tool `execute` 返回 `{ content, details }` | ✅ | 一致 |
| 错误用 `throw new Error()` | ✅ | 一致 |
| 扩展入口注册胶水不含业务逻辑 | ✅ | index.ts 只是注册 |
| `index.ts` 工厂 `export default function workflowExtension(pi)` | ✅ | 一致 |
| 函数不超过 80 行 | ✅ | 各函数均在范围内 |

---

## 6. 安全/性能

| 检查项 | 评价 |
|--------|------|
| `new Function(script)` 安全性 | ✅ Spec 决策，脚本由 AI 生成非用户输入，Worker 同样 eval 执行 |
| 同步 fs 操作 | ✅ 均为一次性写入/移动操作，不阻塞 |
| 路径遍历风险 | ✅ `pathResolve(".pi/workflows/.tmp/")` 硬编码，无用户控制的路径输入 |
| 缓存失效 | ✅ `invalidateCache()` 在 `workflow-generate` 写入后调用，正确 |

---

## 7. 结论

| 维度 | 评分 |
|------|------|
| Spec 合规 | ⚠️ 5/6 FRs 通过，FR6 完全缺失 |
| 代码质量 | ⚠️ 1 个真实 bug (MF1)，1 个功能回退 (MF2) |
| 架构合规 | ⚠️ import 顺序不符合项目规范 (S1) |
| 安全性 | ✅ 无安全风险 |
| 整体 | **FAIL** — 3 个 must_fix 问题 |

**verdict**: fail — 3 个 must_fix 问题需要修复后重新评审

**优先修复顺序**: MF1（bug）→ MF2（功能回退）→ MF3（Spec 不完整），然后处理 S1。
