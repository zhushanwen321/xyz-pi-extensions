# Independent Plan Review (fresh context)

## 审查范围

- spec.md（FR-1~FR-6, AC-1~AC-10, Out-of-Scope, 决策记录）
- plan.md（6 Tasks, Interface Contracts, Spec Coverage Matrix）
- 现有源码：`types.ts`, `core.ts`, `skill-execution.ts`, `run_tests.mjs`
- 3 轮自审报告（验证已修复内容，聚焦盲区）
- Pi SDK 类型定义：`extensions/types.d.ts`（ExtensionContext, registerTool）, `resource-loader.d.ts`, `skills.d.ts`
- 实际文件系统：`~/.pi/agent/skills/`, `~/.pi/agent/npm/node_modules/`

## 发现汇总

| ID | 级别 | 维度 | 位置 | 问题 |
|----|------|------|------|------|
| I1 | MUST_FIX | D | plan Task 2 `scanNpmBundledSkills` | scoped npm package 扫描只检查 1 级深度，漏掉 `@zhushanwen/pi-*/skills` 等所有 scope 化包的 skills |
| I2 | MUST_FIX | D | `skill-registry.ts` + `core.ts` Task 3 Step 5 | `scanSkillNames` 的 fallback 只在 `names.size === 0` 时触发——目录扫描部分命中时 fallback 不运行，scoped packages 遗漏无法补偿 |
| I3 | MINOR | E | plan Task 5 TC-2-01 | 纯字符串 includes 测试，不验证 name 校验实际工作——不检查 `skill-registry.ts` 的函数调用 |
| I4 | MINOR | E | plan Task 5 | `skill-registry.ts`（新建模块）零测试覆盖——`scanSkillNames`/`isValidSkillName` 无任何测试 |
| I5 | MINOR | D | plan Task 4 Step 3 | `errorForceRecordPrompt` 中 `item.metadata.skillMdPath` 在 path 未提供时为 `""`，输出 `Read `（空路径），迷惑 agent |
| I6 | QUESTION | C/E | plan Spec Coverage Matrix | AC-8（name 不存在返回错误）的测试验证方式——TC-2-01 只查源码字符串，不真正调 `use_skill(start, name="不存在")`，验收条件不可达 |

## 详细发现

### I1 [MUST_FIX]: `scanNpmBundledSkills` 漏掉 scoped packages 的 skills

**证据链：**

plan Task 2 `skill-registry.ts` 的 `scanNpmBundledSkills` 函数：

```typescript
function scanNpmBundledSkills(): string[] {
  const names: string[] = [];
  for (const pkgName of readdirSync(NPM_SKILLS_GLOB_ROOT)) {
    const skillsDir = join(NPM_SKILLS_GLOB_ROOT, pkgName, "skills");
    if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
      names.push(...scanDirectChildren(skillsDir));
    }
  }
  return names;
}
```

`NPM_SKILLS_GLOB_ROOT` = `~/.pi/agent/npm/node_modules`

`readdirSync` 返回的条目包含 scoped packages（如 `@zhushanwen`）。当 `pkgName = "@zhushanwen"` 时，检查路径为：
```
~/.pi/agent/npm/node_modules/@zhushanwen/skills
```

**此路径不存在**。实际的 scoped package skills 位于次级目录：
```
~/.pi/agent/npm/node_modules/@zhushanwen/pi-coding-workflow/skills   ✅
~/.pi/agent/npm/node_modules/@zhushanwen/pi-evolve-daily/skills      ✅
~/.pi/agent/npm/node_modules/@zhushanwen/pi-workflow/skills          ✅
```

**实际验证（读文件系统）：**
```bash
$ ls -d ~/.pi/agent/npm/node_modules/@zhushanwen/skills         # NOT FOUND
$ ls -d ~/.pi/agent/npm/node_modules/@zhushanwen/pi-coding-workflow/skills   # EXISTS
$ ls -d ~/.pi/agent/npm/node_modules/pi-subagents/skills                     # EXISTS（非 scoped 正常）
```

**影响：** 所有 `@zhushanwen/pi-*` 扩展内嵌的 skills（xyz-harness-backend-dev、xyz-harness-brainstorming、evolve、ask-user 等）在 name 校验时均不可见。agent 调用 `use_skill(start, name="xyz-harness-backend-dev")` 会返回 "skill not found"，尽管该 skill 确实已安装。

**根因：** 主 agent 写 `node_modules/*/skills` 思维与实际 npm flat structure 不匹配。scoped packages 是 `@scope/name/skills` 而非 `@scope/skills`。这是"想当然的假设"——plan 作者假设 npm 包都是一级目录，未考虑 scoped package 的两级目录结构。

**修复方向：** `scanNpmBundledSkills` 需要额外检查 scoped 包：

```typescript
function scanNpmBundledSkills(): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(NPM_SKILLS_GLOB_ROOT)) {
    // Level 1: unscoped packages (pi-subagents/skills)
    const skillsDir1 = join(NPM_SKILLS_GLOB_ROOT, entry, "skills");
    if (existsSync(skillsDir1) && statSync(skillsDir1).isDirectory()) {
      names.push(...scanDirectChildren(skillsDir1));
    }
    // Level 2: scoped packages (@scope/name/skills)
    if (entry.startsWith("@")) {
      const scopeDir = join(NPM_SKILLS_GLOB_ROOT, entry);
      if (statSync(scopeDir).isDirectory()) {
        for (const subPkg of readdirSync(scopeDir)) {
          const skillsDir2 = join(scopeDir, subPkg, "skills");
          if (existsSync(skillsDir2) && statSync(skillsDir2).isDirectory()) {
            names.push(...scanDirectChildren(skillsDir2));
          }
        }
      }
    }
  }
  return names;
}
```

### I2 [MUST_FIX]: Fallback 只能零命中补救，不能补充扫描遗漏

**证据链：**

`skill-registry.ts` 的 `scanSkillNames`：
```typescript
export function scanSkillNames(systemPrompt?: string): Set<string> {
  // ... 目录扫描 ...
  
  // Fallback: 目录扫描无命中时
  if (names.size === 0 && systemPrompt) {  // <-- 只检查 names.size === 0
    for (const name of extractFromSystemPrompt(systemPrompt)) {
      names.add(name);
    }
  }
  return names;
}
```

`core.ts` Task 3 Step 5 的调用：
```typescript
const systemPrompt = typeof getPrompt === "function" ? getPrompt() : undefined;
if (!isValidSkillName(skillName, systemPrompt)) {
  return { content: [{ type: "text" as const, text: `skill "${skillName}" not found` }], ... };
}
```

**情景分析：** `.agents/skills/` 有 `code-review`, `dev-link`, `merge`, `pull-request` 四个目录。目录扫描返回 names.size = 4（非 0）。但 scoped npm packages 的 skills（`xyz-harness-backend-dev` 等）因 I1 缺失，而 fallback 不会运行。

结果：agent 调用 `use_skill(start, name="xyz-harness-backend-dev")` → `isValidSkillName` 检查只扫到 4 个目录级 skill → 返回 "not found"。

**影响：** 主 agent 设计的 fallback 机制（`system prompt` 提取）是合理的安全网，但触发条件太窄。它只在"目录扫描零命中"时生效，而对"目录扫描部分命中但遗漏"无效。越不依赖 system prompt fallback，就越依赖目录扫描的完整——而 I1 让目录扫描天然不完整。

**修复方向（方案一，推荐）：** 始终从 system prompt 提取技能追加到结果集，不限于零命中：

```typescript
  // Fallback: 从 system prompt 提取 skill 名称作为补充
  if (systemPrompt) {
    for (const name of extractFromSystemPrompt(systemPrompt)) {
      names.add(name);
    }
  }
```

**方案二（保守）：** 修复 I1 后保留现有 fallback 逻辑。代价是 system prompt fallback 被拆掉一层防护。

### I3 [MINOR]: TC-2-01 测试有效性不足

**证据链：**

plan Task 5 Step 4 的 TC-2-01：
```javascript
// TC-2-01: use_skill(start) 的 name 校验逻辑存在
{
  const fs = await import("node:fs");
  const coreSrc = fs.readFileSync(join(__dirname, "core.ts"), "utf-8");
  const hasValidation = coreSrc.includes('isValidSkillName');
  const hasNotFound = coreSrc.includes('not found');
  const passed = hasValidation && hasNotFound;
  record("TC-2-01", passed, ...);
}
```

**仅验证了：** `core.ts` 源码中写了 `isValidSkillName` 字符串和 `not found` 字符串。

**不能验证的：**
- `isValidSkillName` 是否真的被调用（字符串存在 ≠ 被调用）
- `isValidSkillName` 的参数传递是否正确（用哪个 systemPrompt 参数？）
- `skill-registry.ts` 的目录扫描是否正确工作
- `isValidSkillName("zcommit")` 在开发机上是否返回 true
- `isValidSkillName("不存在")` 是否返回 false（AC-8 核心验证点）

**影响：** 如果 `skill-registry.ts` 的函数被误写（如路径错误、glob 模式错），TC-2-01 仍会通过。AC-8 的验收条件"name 不存在返回错误提示"在测试中无任何保障。

**修复方向：** 增加集成测试（纯 JS 内联 `skill-registry.ts` 逻辑，用 mock 目录或 `__fixtures__` 验证）：

```javascript
// TC-2-03: isValidSkillName 对有 SKILL.md 的目录返回 true
{
  // 使用开发机实际存在的 skill 目录做验证
  const fs = await import("node:fs");
  const actualSkillsDir = join(os.homedir(), ".pi/agent/skills");
  const skills = fs.readdirSync(actualSkillsDir).filter(...);
  // 至少有一个已知 skill
  const passed = skills.length > 0;
  record("TC-2-03", passed, ["...验证已知 skill 名称"], `found ${skills.length} skills`);
}
```

### I4 [MINOR]: `skill-registry.ts` 零测试覆盖

plan 的 Task 5 覆盖了以下维度：
- core.ts 框架结构（TC-1-01）
- skill-execution.ts 配置（TC-2-02）
- 状态机转换（TC-3-01~05）
- 错误阈值（TC-4-01）
- session restore（TC-5-01/02）
- remind（TC-6-01）
- abandoned 检查（TC-7-01/02）

**但没有任何一个测试用例直接测试 `skill-registry.ts` 导出的 `scanSkillNames` 或 `isValidSkillName` 函数。**

这是 plan 中唯一的新建模块（其他都是 modify），零测试。而正如 I1 所揭示的，这个模块有潜在的 scoped package 扫描盲区——没有测试意味着这个盲区会在 CI 中静默存在。

### I5 [MINOR]: `errorForceRecordPrompt` 在 path 未提供时输出空路径

plan Task 4 Step 2 `errorForceRecordPrompt`：
```typescript
function errorForceRecordPrompt(item: TrackedItem<SkillMeta>): string {
  return (
    `...\n` +
    `1. Read ${item.metadata.skillMdPath}\n` +   // <-- 可能为 ""
    ...
  );
}
```

`skillMdPath` 的来源（Task 4 Step 3 `extractMeta`）：
```typescript
extractMeta: (params) => {
  const path = params.path as string | undefined;
  return {
    metadata: { skillMdPath: path ?? "" },  // <-- path undefined 时留空
  };
},
```

虽然 spec FR-2 明确允许 path 缺失且"不阻断创建"，但在 error 场景下 steering 提示 agent "Read " 是不完整的指引。agent 可能困惑要读什么文件。

**严重度评估：** 实际影响低——agent 大概率会忽略这个具体指令。但属于"明知输出不对但还是写了"的模式。

### I6 [QUESTION]: AC-8 的可验证性

AC-8: `use_skill(start, name="不存在")` 返回错误提示 "skill not found"

Spec Coverage Matrix 将此 AC 对应到 `isValidSkillName`（Task 2），但：
1. Task 5 的测试（TC-2-01）只验证源码中有这个字符串，不验证实际返回值
2. Task 6 的端到端验证没有测试 AC-8

这意味着从 spec → plan → test 的验证链中存在 gap。spec 写了 AC-8，plan 实现了功能，但测试没有验证功能是否正确。

**这不是必须修的 bug**（依赖 Task 6 的手动验证），但需注意。

## 与主 agent 自审的对比

### 主 agent 已发现并修复的（不重复审查）

| 轮次 | 已修复内容 | 验证结果 |
|------|-----------|---------|
| R1 | 行号 → 函数名定位、Step 7 矛盾、契约签名不一致、Task 4 placeholder | ✅ 全部落地 |
| R2 | triggerMatch 签名保留 ctx 参数、条件必填说明、isPathInCwd 删除 | ✅ 全部落地 |
| R3 | test_cases type schema 违规、Task 5 保留说明、index.ts 检查 | ✅ 已落地 |

### 主 agent 的盲区（本轮新发现）

| 盲区 | 为什么自审难突破 | 对应 ID |
|------|----------------|--------|
| **scoped npm package 扫描**：写 `readdirSync(NPM_GLOB) → join(NPM_GLOB, pkg, "skills")` 时，作者自然认为 pkg 是 pi-subagents 这样的包名，没意识到 scoped 包 `@zhushanwen` 本身没有 skills 子目录 | 这是文件系统结构的假设性错误。自审读"自己的代码"时，会潜意识里觉得"遍历所有包→每个包下有 skills 目录"的逻辑是合理的。只有独立验证文件系统结构才能发现 | I1, I2 |
| **fallback 触发条件过窄**：`names.size === 0` 作为 fallback 条件，在"部分命中"时失效。自审中作者觉得"fallback 是安全的"，但没考虑目录扫描和 fallback 的组合失败场景 | fallback 的设计意图是"兜底"，自审时作者满足于"有 fallback"的安全感，没检查 fallback 的触发条件是否足够宽 | I2 |
| **skill-registry 零测试覆盖**：新建模块无测试。自审中作者的注意力集中在"改已有代码"（core.ts, types.ts, skill-execution.ts）的测试重写上，忽略了新建模块的测试 | 新建模块在计划中总是被看作"辅助工具"，自审倾向认为"它很小不用测"。这是代码审查中常见的注意力分配偏差 | I4 |
| **TC-2-01 测试有效性**：字符串 includes 测试能通过作者的所有自审标准（存在、有行号引用等），但独立评估发现它几乎不验证 target 功能 | 写测试的作者知道"isValidSkillName 被调用了"并通过了这个测试，就满足了。自审不会质疑"这个测试到底验不验证需求" | I3 |

## 收敛判定

**不收敛。需要至少再修 1 轮。**

原因：

1. **I1（scoped npm 扫描遗漏）是设计缺陷**，非表面合规问题。它影响核心功能（name 校验）的正确性，且是全量真实失效（所有 `@zhushanwen/pi-*` 的 skills 均不可见）。

2. **主 agent 的 R3 收敛判定为 CONVERGED 时的假设条件已失效**——R3 唯一的 MUST_FIX（R3-01 test_cases type schema）是表面合规问题，而真正的逻辑漏洞（I1）从未被触及。

3. **I1 和 I2 组合**：即使修复了 I1（正确扫描 scoped packages），如果目录扫描在其他环境下仍有遗漏，I2 的 fallback 条件过窄仍需修复。两个问题需同时处理。

4. 修复建议在 plan 的 Task 2 处修改（`skill-registry.ts` 实现），影响范围局部。Task 的数量和依赖关系不变。

### 修复后验证清单

修复后需验证：

- [x] `scanNpmBundledSkills` 能发现 `@zhushanwen/pi-coding-workflow/skills` 内的 skill 目录 → I1 已修：scoped 两级扫描
- [x] `scanSkillNames` 的 fallback 不受 `names.size === 0` 限制 → I2 已修：system prompt 始终补充
- [ ] `isValidSkillName("xyz-harness-backend-dev")` 在开发机上返回 true → 实施时验证
- [x] TC-2-01 增强或新增 skill-registry 测试 → I3+I4 已修：新增 TC-2-03

---

## 主 agent 修复记录（独立审查后）

独立审查发现 2 MUST_FIX + 4 MINOR/QUESTION。主 agent 修复情况：

| ID | 级别 | 修复内容 |
|----|------|----------|
| I1 | MUST_FIX | `scanNpmBundledSkills` 改为两级扫描：unscoped (`pkg/skills`) + scoped (`@scope/pkg/skills`) |
| I2 | MUST_FIX | `scanSkillNames` 的 system prompt 提取从 `names.size === 0` 条件改为始终执行 |
| I3+I4 | MINOR | 新增 TC-2-03，验证 scoped package 扫描逻辑（代码检查 + 开发机实际发现） |
| I5 | MINOR | `errorForceRecordPrompt` 加 path 缺失 guard（空时用 skill name 描述） |
| I6 | QUESTION | AC-8 可验证性由 TC-2-03 部分改善（验证扫描逻辑）；完整功能验证依赖 Task 6 手动验证 |

Interface Contracts 的 Edge Cases 描述同步更新。
