# Extension 审查报告: claude-rules-loader

> 审查员: Pi Extension 规范审查员
> 审查日期: 2026-06-05
> 审查对象: `/Users/zhushanwen/Code/xyz-pi-extensions-workspace/feat-production-level/extensions/claude-rules-loader/`
> 审查依据: `docs/pi-extension-standards.md`（xyz-pi 扩展开发规范 v0.75.5-xyz-0.4）

## 基本信息

| 项目 | 值 |
|------|------|
| 包名 | `@zhushanwen/pi-claude-rules-loader` |
| 版本 | `0.1.1` |
| 描述 | Load CLAUDE.md rules for Pi coding agent |
| 入口文件 | `index.ts` (238 行) |
| 文件数 | 4（`index.ts`、`package.json`、`tsconfig.json`、`README.md`） |
| 总行数 | 301 行 |
| 入口 Type | `export default function claudeRulesLoader(pi)`（**命名函数**） |
| 注册的工具/命令 | 无（仅事件处理器） |
| 第三方依赖 | 无 |

## 审查结果概览

| # | 规范项 | 状态 | 严重程度 | 说明 |
|---|--------|------|----------|------|
| 1 | 包名格式 `@scope/pi-<name>` | ✅ 合规 | — | `@zhushanwen/pi-claude-rules-loader` |
| 2 | `package.json` 必需字段 | ❌ 不合规 | **P0** | 缺少 `license` 字段 |
| 3 | `type: "module"` | ✅ 合规 | — | 已设定 |
| 4 | `files` 包含入口 | ✅ 合规 | — | `["index.ts"]` |
| 5 | `pi.extensions` 指向入口 | ✅ 合规 | — | `["./index.ts"]` |
| 6 | `keywords` 字段 | ⚠️ 部分合规 | P2 | 仅一个 `pi-package`，建议补充 |
| 7 | Pi SDK 在 `peerDependencies` 且非 optional | ✅ 合规 | — | `@mariozechner/pi-coding-agent: ">=0.1.0"` |
| 8 | `export default function(pi)` | ⚠️ 部分合规 | P2 | 使用了命名函数 `claudeRulesLoader`，规范建议匿名 |
| 9 | 闭包状态隔离 | ✅ 合规 | — | `unconditionalRules` / `conditionalRules` 在工厂内 |
| 10 | 工厂函数 ≤ 100 行（按职责拆分） | ✅ 合规 | — | 工厂本身约 100 行，子函数已拆分 |
| 11 | Tool 注册规范 | N/A | — | 未注册 Tool |
| 12 | 事件处理器 ≤ 20 行 | ❌ 不合规 | **P1** | `session_start` 58 行，`before_agent_start` 34 行 |
| 13 | `agent_end` 不启动 LLM | ✅ 合规 | — | 未注册 `agent_end` |
| 14 | `session_tree` 清理旧分支 | N/A | — | 未注册 `session_tree` |
| 15 | 反序列化向后兼容 | N/A | — | 无持久化状态 |
| 16 | Stale Context 检测 | ⚠️ 缺失 | **P1** | `ctx.ui.notify` 无 `isStaleContextError` 保护 |
| 17 | 防重入 | ✅ 合规 | — | 不存在并发触发路径 |
| 18 | 函数控制流显式 return | ✅ 合规 | — | — |
| 19 | 禁止 `any` | ❌ 不合规 | **P1** | `index.ts:141, 204` 使用 `any`（CI 兜底但仍可避免） |
| 20 | `Record<string, unknown>` 白名单 | ✅ 合规 | — | 未使用 |
| 21 | 跨文件类型集中 | ✅ 合规 | — | 类型已集中在 `index.ts` 顶部（单文件场景） |
| 22 | 禁止硬编码路径 | ❌ 不合规 | **P1** | `index.ts:142` 使用 `process.env.HOME` 而非 `homedir()` |
| 23 | 依赖在 `dependencies` 声明 | ✅ 合规 | — | 无第三方运行时依赖 |
| 24 | 禁止 `process.exit` | ✅ 合规 | — | 未使用 |
| 25 | 禁止无限循环无上限 | ✅ 合规 | — | `while` 循环有自然终止条件（爬升至 root） |
| 26 | 异步操作支持 `signal` | ⚠️ 缺失 | **P1** | `session_start` 处理器不传 `ctx.signal`（且本身非异步 IO） |
| 27 | 单文件 ≤ 500 行 | ✅ 合规 | — | 238 行 |
| 28 | 函数 ≤ 80 行 | ⚠️ 部分合规 | P2 | `session_start` 内部代码块（58 行）、`loadRulesFromDir` 内部 callback 较长 |
| 29 | 事件处理器 ≤ 20 行 | ❌ 不合规 | **P1** | 同 #12 |
| 30 | TUI 语义 token 着色 | N/A | — | 无 TUI 渲染 |
| 31 | Monorepo Import 顺序 | ✅ 合规 | — | Node 内置 → Pi SDK |
| 32 | 单文件 ≤ 1000 行 | ✅ 合规 | — | 238 行 |

**合规率: 23 / 32 = 71.9%**（不含 N/A 项 35.9%）

## 详细问题清单

### P0 问题（崩溃风险 / 阻塞发布）

#### P0-1: `package.json` 缺少 `license` 字段

**文件**: `extensions/claude-rules-loader/package.json`

**规范依据**: §1.2 必需字段

```jsonc
{
  // 缺少以下字段
  "license": "MIT",
}
```

**影响**:
- npm publish 时会发出 warning（`npm WARN ... no license field`）
- 仓库级 audit 工具（如 `license-checker`）无法识别许可证
- 不符合 §1.2 必需字段清单

**修复建议**:
```diff
  "keywords": [
    "pi-package"
  ],
+ "license": "MIT",
  "files": [
    "index.ts"
  ],
```

---

### P1 问题（结构性问题 / 健壮性）

#### P1-1: 事件处理器严重超出 20 行限制

**文件**: `extensions/claude-rules-loader/index.ts`

**位置**:
- L141–198: `session_start` 处理器 — **58 行**
- L204–237: `before_agent_start` 处理器 — **34 行**

**规范依据**: §6.2 "每个事件处理器不超过 20 行，复杂逻辑提取为命名函数"

**问题代码**（摘录 session_start 起点）:
```typescript
// L141-198: 58 行 session_start 处理器
pi.on("session_start", async (_event: any, ctx: any) => {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";
    const allRules: RuleFile[] = [];
    // 1. Global rules: ~/.claude/rules/
    if (homeDir) { ... }
    // 2. Project rules: walk from root to CWD (like Claude Code)
    const loadedRealPaths = new Set<string>(allRules.map((r) => r.realPath));
    const dirs: string[] = [];
    let current = ctx.cwd;
    while (current !== path.parse(current).root) { ... }
    dirs.reverse();
    for (const dir of dirs) { ... }
    unconditionalRules = allRules.filter((r) => !r.globs).sort(...);
    conditionalRules = allRules.filter((r) => r.globs).sort(...);
    if (total > 0) { ctx.ui.notify(...); }
});
```

**修复建议**: 拆分为命名函数
```typescript
pi.on("session_start", async (_event, ctx) => {
    const allRules = collectAllRules(ctx.cwd);
    partitionRules(allRules);
    if (allRules.length > 0) safeNotify(ctx, ...);
});

function collectAllRules(cwd: string): RuleFile[] { ... }
function partitionRules(rules: RuleFile[]): void { ... }
```

---

#### P1-2: 事件签名使用 `any`，违反类型安全规范

**文件**: `extensions/claude-rules-loader/index.ts`

**位置**:
- L141: `pi.on("session_start", async (_event: any, ctx: any) => {`
- L204: `pi.on("before_agent_start", async (event: any) => {`

**规范依据**: §11.1 "禁止 any"；§6.1 事件类型表

**问题代码**:
```typescript
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Pi event types are typed as `any` in CI stubs
pi.on("session_start", async (_event: any, ctx: any) => {
```

**问题分析**:
- 注释称 "CI stubs are typed as `any`"，但 `tsconfig.json` paths 配置**优先**解析到真实 Pi 类型（`dist/index.d.ts`），因此本地开发与 CI 都有 `SessionStartEvent`、`BeforeAgentStartEvent`、`ExtensionContext` 等具体类型可用
- 即使 CI 必须用 `any`，也应仅在类型 stub 内部使用，不应泄漏到扩展源代码

**修复建议**:
```typescript
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
// 使用 Pi 提供的具名事件类型（如有），否则用 unknown + 守卫
pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    // ...
});
```

注：若 `ExtensionAPI` 的 `on` 方法签名是重载联合，可通过 `Parameters<ExtensionAPI["on"]>[1]` 推断出 `ctx` 的真实类型。简单做法是 `ctx: Parameters<Parameters<ExtensionAPI["on"]>[0]>[1]` 之类。

---

#### P1-3: Stale Context 检测缺失

**文件**: `extensions/claude-rules-loader/index.ts`

**位置**: L196–199（`ctx.ui.notify` 调用点）

**规范依据**: §10.1 "Stale Context 检测"

**问题代码**:
```typescript
// L196-199
const total = unconditionalRules.length + conditionalRules.length;
if (total > 0) {
    ctx.ui.notify(
        `Claude rules: ${unconditionalRules.length} loaded, ${conditionalRules.length} conditional`,
        "info",
    );
}
```

**问题分析**:
- `session_start` 虽是同步触发的，但若 `ctx` 已被销毁（极少见但可能发生在 session 异常退出后再次启动），`ctx.ui.notify` 会抛 "Extension context no longer active"
- 虽然 `session_start` 触发的瞬间 `ctx` 通常有效，但规范要求跨越生命周期边界的操作都应加 `safeNotify` 保护

**修复建议**:
```typescript
function isStaleContextError(error: unknown): boolean {
    return error instanceof Error
        && error.message.includes("Extension context no longer active");
}

function safeNotify(ctx: { ui: { notify: (m: string, t?: string) => void } }, msg: string, type: "info" | "warning" | "error" = "info"): void {
    try {
        ctx.ui.notify(msg, type);
    } catch (err) {
        if (!isStaleContextError(err)) throw err;
    }
}
```

---

#### P1-4: 硬编码 `process.env.HOME`，未使用 `homedir()`

**文件**: `extensions/claude-rules-loader/index.ts`

**位置**: L142

**规范依据**: §12.1 "禁止硬编码路径，必须使用 `path.join()` + `homedir()` 构造"

**问题代码**:
```typescript
const homeDir = process.env.HOME || process.env.USERPROFILE || "";
```

**问题分析**:
- `process.env.HOME` 在 Linux/macOS 存在但 Windows 默认没有；当前代码同时回退到 `USERPROFILE`，这是手动处理跨平台逻辑
- Node.js 提供 `os.homedir()`，在所有平台自动选择正确的环境变量
- 同仓库其他扩展（`coding-workflow/lib/skill-resolver.ts`、`model-switch/src/setup.ts` 等）均使用 `homedir()`，保持一致

**修复建议**:
```typescript
import { homedir } from "node:os";

// L142 改为
const homeDir = homedir();
```

---

#### P1-5: `session_start` 中可能的 `path.parse` 边界 bug

**文件**: `extensions/claude-rules-loader/index.ts`

**位置**: L160–165

**规范依据**: §13 健壮性

**问题代码**:
```typescript
let current = ctx.cwd;
while (current !== path.parse(current).root) {
    dirs.push(current);
    current = path.dirname(current);
}
dirs.push(path.parse(current).root); // include root itself
```

**问题分析**:
- 当 `ctx.cwd` 已经是 root（如 Windows `C:\` 或 Linux `/`）时，`while` 循环**不进入**，直接执行 `dirs.push(path.parse(current).root)`，把 root 推入。这是正确的 ✓
- 但 `path.parse("/").root === "/"`，`path.parse("C:\\").root === "C:\\"`，循环退出条件成立 — 这部分**逻辑正确**
- **次要问题**: 未处理 `ctx.cwd` 为空字符串或非绝对路径的异常场景（如扩展从非正常路径加载）。规范 §13.1 要求"不允许未捕获异常"
- 若 `ctx.cwd === ""`，`path.parse("").root === ""`，`path.dirname("")` 返回 `"."`，**会进入死循环**（`path.dirname(".") === "."`）

**修复建议**:
```typescript
let current = ctx.cwd;
if (current) { // 防御性检查
    while (current && current !== path.parse(current).root) {
        dirs.push(current);
        const parent = path.dirname(current);
        if (parent === current) break; // 防止病态路径
        current = parent;
    }
    dirs.push(path.parse(current).root);
}
```

---

### P2 问题（风格 / 优化建议）

#### P2-1: 默认导出使用了命名函数

**文件**: `extensions/claude-rules-loader/index.ts`

**位置**: L135

**规范依据**: §2.1 "函数名用匿名函数或 `extension`，不命名（无调用方）"

```typescript
export default function claudeRulesLoader(pi: ExtensionAPI) {
```

**修复建议**:
```typescript
export default function (pi: ExtensionAPI) {
    // ...
}
```

#### P2-2: 缩进风格不统一（Tab 与 Space 混用）

**文件**: `extensions/claude-rules-loader/index.ts`

**位置**:
- L111–133（`loadRulesFromDir` 函数体）使用 **Tab** 缩进
- L140–141、L203–204（事件注册行）使用 **Tab** 缩进
- 其余全部使用 **4 空格** 缩进

**证据**:
```
$ awk '/^\t/ {print NR": "$0}' index.ts
112: 	rulesDir: string,
113: 	displayPrefix: string,
115: 	const files = findMarkdownFiles(rulesDir);
...
141: 	pi.on("session_start", async (_event: any, ctx: any) => {
...
```

**修复建议**: 全文件统一为 4 空格缩进。

#### P2-3: `keywords` 仅一个元素

**文件**: `extensions/claude-rules-loader/package.json`

**位置**: L11–13

**规范依据**: §1.2 示例含多个关键词

```json
"keywords": ["pi-package"]
```

**修复建议**:
```json
"keywords": ["pi-package", "pi", "pi-coding-agent", "extension", "claude", "rules"]
```

#### P2-4: 默认导出的工厂函数 + 三个独立子函数同文件

**文件**: `extensions/claude-rules-loader/index.ts`

**说明**: 工厂本身约 100 行 + `parseFrontmatter` (40 行) + `findMarkdownFiles` (32 行) + `loadRulesFromDir` (20 行) + `interface RuleFile` + 工厂 100 行 = 约 238 行（与行数吻合）。单文件 ≤ 500 行 ✓，但 `parseFrontmatter` 仍可拆为 `frontmatter.ts` 以提升可测试性（[指南] §15）。

**修复建议（可选）**:
```
claude-rules-loader/
├── index.ts
├── src/
│   ├── frontmatter.ts   # parseFrontmatter + 类型
│   ├── walker.ts        # findMarkdownFiles + loadRulesFromDir
│   └── rules.ts         # collectAllRules, partitionRules
├── package.json
├── README.md
└── test/
```

#### P2-5: README.md 中安装命令路径错误

**文件**: `extensions/claude-rules-loader/README.md`

**位置**: L17

```markdown
ln -s /path/to/xyz-pi-extensions-workspace/main/packages/claude-rules-loader \
      ~/.pi/agent/extensions/claude-rules-loader
```

**问题**: 实际目录是 `feat-production-level/extensions/claude-rules-loader`，不是 `main/packages/...`。这会让用户按文档 symlink 后找不到入口。

**修复建议**:
```markdown
ln -s /path/to/xyz-pi-extensions-workspace/feat-production-level/extensions/claude-rules-loader \
      ~/.pi/agent/extensions/claude-rules-loader
```

#### P2-6: 缺少测试文件

**文件**: 整个扩展

**规范依据**: §17 [指南]

**说明**: 该扩展有可独立测试的纯函数（`parseFrontmatter`、`findMarkdownFiles`、`loadRulesFromDir`），非常适合单元测试。当前无 `test/` 目录。

**修复建议**: 添加 `test/frontmatter.test.ts`、`test/walker.test.ts` 使用 `vitest`。

---

## 优点

1. **核心架构设计良好**:
   - 单文件、无外部依赖，职责清晰：发现 → 加载 → 排序 → 注入
   - 工厂函数将状态隔离在闭包内（`unconditionalRules` / `conditionalRules`），无模块级全局变量
   - 利用 `realpathSync` 做 symlink 去重，体现了对生产环境的考虑
   - 对称链接循环检测（`visited` Set）健壮

2. **KV cache 稳定性考虑周到**:
   - 加载时一次性排序（`localeCompare`），保证注入位置确定性
   - 注释明确说明 "Sort once at load time for KV cache stability"

3. **错误处理分层合理**:
   - 文件系统错误（EACCES / ENOENT）静默跳过，不阻断整个加载流程
   - `try/catch` 包裹每个文件读取，单文件错误不影响其他文件
   - 解析后的 `content` 为空时跳过

4. **Frontmatter 解析支持多种格式**:
   - 同时支持 inline array `paths: ["*.ts"]` 和 block array `paths:\n  - *.ts`
   - 字符串引号处理（`replace(/^['"]|['"]$/g, "")`）

5. **配置正确**:
   - `type: "module"` ✓
   - `pi.extensions: ["./index.ts"]` ✓
   - `files: ["index.ts"]` ✓
   - `peerDependencies` 正确且非 optional ✓

6. **README 包含中文说明和安装/使用示例**:
   - 优先级顺序描述清楚
   - 提供了 symlink 和 npm 两种安装方式

---

## 改进建议

### 优先级 1（必须修复，下个版本前）

1. **添加 `license` 字段** (P0-1)
2. **将两个事件处理器拆分为命名子函数** (P1-1)
3. **使用 `homedir()` 替代 `process.env.HOME`** (P1-4)
4. **替换 `any` 类型为 Pi 真实事件类型** (P1-2)

### 优先级 2（强烈建议）

5. **添加 `safeNotify` 包装 + `isStaleContextError` 检查** (P1-3)
6. **修复 `path.parse` 边界防御** (P1-5)
7. **修复 README.md 中的安装路径** (P2-5)

### 优先级 3（推荐优化）

8. **统一缩进风格（全部 4 空格）** (P2-2)
9. **补充 `keywords`** (P2-3)
10. **改为匿名默认导出** (P2-1)
11. **添加 vitest 单元测试覆盖 `parseFrontmatter` / `findMarkdownFiles`** (P2-6)
12. **考虑拆分 `src/` 子模块以提升可测性** (P2-4)

### 架构亮点（保持）

- 闭包状态隔离
- 对称链接循环检测
- KV cache 友好的确定性排序
- Frontmatter 解析支持 inline / block 两种格式

---

## 总结

`claude-rules-loader` 是一个**功能定位清晰、实现克制**的小型扩展，核心逻辑（frontmatter 解析 + 目录遍历 + 排序注入）质量良好，体现了对边界条件（symlink 循环、文件系统权限、KV 缓存）的考虑。

主要问题集中在**规范合规性**层面：
- 一项 **P0** 阻塞项（缺少 `license` 字段）
- 五项 **P1** 健壮性/结构性问题（事件处理器膨胀、`any` 类型、Stale Context 缺失、路径硬编码、边界防御）

修复所有 P0/P1 预计需要约 1.5 小时工作量，且**不会改变运行时行为**，仅提升规范合规性与可维护性。建议在下一次版本发布（0.2.0）前完成 P0/P1 修复。

**总体评级**: B-（功能完整，规范合规性需提升）

