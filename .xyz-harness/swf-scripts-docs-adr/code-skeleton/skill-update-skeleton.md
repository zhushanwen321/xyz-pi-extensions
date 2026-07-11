# Skill 文档更新骨架（UC-9 workflow-script-format + UC-11 coding-execute）

> **8 文件合并裁决**（code-architecture.md §9）：§B 列 5 项文档/配置契约，输出文件列表限定 8 个。
> coding-execute skill 骨架无独立文件 → **合并进本骨架**（两 skill 同属「skill 文档更新」类目，分两段）。
>
> 本骨架为内容骨架（可校验），实现时填充到对应 SKILL.md。

---

# §1 workflow-script-format skill 更新（UC-9 / #4）

## 实现文件路径

`extensions/subagents-workflow/skills/workflow-script-format/SKILL.md`
（T1 已将 skill 从 pi-workflow 迁入新包，T3 填 workflow() 文档内容）

## 改动 1：新增 `workflow()` 函数文档段

> 插入位置：`## Injected Globals` 节，`### parallel(calls)` 段之后、`### pipeline(...)` 段之前。

```markdown
### `workflow(name, args?)` — Call a nested workflow

> **workflow 嵌套**：在一个 workflow 脚本内调用另一个 workflow，实现顺序/并行/scatter-gather/map-reduce 编排。

支持签名：
- `workflow(name: string)` — 调用指定 workflow（无入参）
- `workflow(name: string, args: Record<string, unknown>)` — 调用 workflow + 传入参数（被调 workflow 用 `$ARGS` 接收）

返回 `AgentResult`，与 `agent()` 返回类型一致：

```typescript
interface AgentResult {
  content: string;           // workflow 脚本的 return 值（字符串化）
  parsedOutput?: unknown;    // workflow 脚本 return 对象时为 parsed 值
  usage?: AgentUsage;        // token 消耗
  error?: string;            // workflow 失败时填（不 throw，由调用方检查）
}
```

**信号/预算传播**：
- `signal`：从父 workflow 的 Worker context 继承（父 abort → 子 workflow abort）
- `timeoutMs`：从父 workflow 的 budget 计算剩余时间
- `depth`：自动 +1，触发分层配额（见 parallel() 上限说明）+ 嵌套护栏（MAX_FORK_DEPTH）

**示例**（基础用法，与 examples/ 完整脚本分工：此处教 API，examples/ 教模式）：

```javascript
// 顺序：workflow A → workflow B，A 输出作 B 输入
const a = await workflow("extract", { source: "input.json" });
if (a.error) throw new Error("extract 失败: " + a.error);
const b = await workflow("transform", { raw: a.content });
return { final: b.content };
```

**错误处理**：workflow 失败不 throw，返回 `error` 字段。调用方必须检查（参考 examples/chain.example.js 的 try-catch 模式）。
```

## 改动 2：更新 parallel() 并发上限 4 → 6

> 改动位置：`### parallel(calls)` 段的并发说明 + `## Constraints` 节。

**原文**（需改）：
```markdown
并发默认上限 4（agent-pool 限流），超出自动排队。
```

**改为**：
```markdown
并发默认上限 6（ConcurrencyPool 限流，来源 T2 maxConcurrent=6）。超出自动排队。

**分层配额**：workflow 嵌套时按 depth 分层。depth=N 的子层可用配额 = max(1, 6 - N)，
保底 1 槽防饿死。例：顶层 workflow（depth=0）可用 6 槽；嵌套一层（depth=1）可用 5 槽。
parallel() 内的 agent()/workflow() 调用共享父 workflow 的配额池。
```

**Constraints 节同步**：
```markdown
- `parallel()` 并发默认上限 6（超出自动排队）；workflow 嵌套时按 depth 分层配额 max(1, 6-depth)。
```

## 改动 3：新增 chain/parallel 基础示例

> 插入位置：`## Complete Example` 节之前，新增 `## workflow() 嵌套基础示例` 小节。
> 与 examples/ 分工：此处简洁（3-5 行教 API），examples/ 完整（含错误处理/多段/配额注释）。

```markdown
## workflow() 嵌套基础示例

### chain（顺序编排）

```javascript
const meta = { name: "my-chain", description: "顺序编排", phases: ["chain"] };
const a = await workflow("step-a", { input: $ARGS.input });
const b = await workflow("step-b", { raw: a.content });
return { result: b.content };
```

### parallel（并行编排）

```javascript
const meta = { name: "my-parallel", description: "并行编排", phases: ["parallel"] };
const [r1, r2, r3] = await parallel([
  workflow("analyze-a", { target: $ARGS.target }),
  workflow("analyze-b", { target: $ARGS.target }),
  workflow("analyze-c", { target: $ARGS.target }),
]);
return { results: [r1.content, r2.content, r3.content] };
```

> 完整模式（scatter-gather/map-reduce/含错误处理）见包内 `examples/` 目录。
```

## §6 测试校验点

- [ ] T9.1：grep `workflow(` 函数文档段
- [ ] T9.2：grep 上限 `6`，不命中旧「上限 4」
- [ ] T9.3：grep chain + parallel 基础示例
- [ ] T9.4：`python3 .githooks/validate-skill-yaml.py` frontmatter 合法
- [ ] T9.5：skill 可被 workflow-generate 自动加载（description 含触发词）

---

# §2 coding-execute skill 更新（UC-11 / #5，D-033R）

## 实现文件路径

`extensions/coding-workflow/skills/coding-execute/SKILL.md`
（跨包编辑：coding-workflow 包，T3 转移 ADR-029 决策 2 的 worktree 编排知识）

## 改动：新增「worktree 编排模式」段

> 插入位置：coding-execute SKILL.md 的执行模式说明节。
> 内容来源：ADR-029 决策 2 原文（worktree 生命周期归 workflow 内建，原生 git worktree add/remove，4 phase 结构）。
> D-033R：ADR-029 决策 2 被 ADR-030 部分 superseded，知识转移到本 skill，不丢失。

```markdown
## Worktree 编排模式（execute-full-workflow.js 内建）

> 来自 [ADR-029 决策 2](../../../../docs/adr/029-full-workflow-takeover-with-worktree.md)（部分 superseded by ADR-030，
> worktree 编排知识转移至此）。execute-full-workflow.js 全流程自包含 worktree 生命周期管理，
> 主 agent 只调一次 `workflow run`，不预建 worktree。

### 4 Phase 结构

```
Phase 0: worktree-setup
  读 plan.json waves + testCases
  → 按并行组算出需要的 worktree 数（dev pool + 1 test + 1 review）
  → 原生 `git worktree add <path> -b <branch> <base>`（不依赖 .bare 结构）
  → 记录路径清单（失败则 throw，已建的留给 cleanup）

Phase 1: dev waves（二维数组调度）
  for each devWave:                    // wave 间串行（dependsOn 拓扑序）
    parallel(wave.cases.map(case =>    // wave 内并行（同 parallelGroup）
      agent({ cwd: case.worktree, task: "TDD 实现 + commit + cw(dev)" })
    ))
  → dev 聚合：所有 sub-wave 分支 merge 到 aggregateBranch

Phase 2: test + review（聚合分支建 worktree，并行）
  testWorktree（从 aggregateBranch 建）→ parallel 跑 test-runner
  reviewWorktree（从 aggregateBranch 建）→ parallel 跑 2 路 reviewer
  → 收集 test-results + review must_fix

Phase 3: worktree-cleanup（finally 块，必跑）
  `git worktree remove <每个 worktree>` + `git branch -D`
  → 失败不阻断 return（记录 cleanup_failures，主 agent 提示用户手动清理）
```

### 关键约束

- **原生 git worktree**：用 `git worktree add`/`git worktree remove`（任何 git 仓库都支持），
  不依赖 `create-worktree.sh`（后者强依赖 `.bare` bare repo 结构，目标项目未必有）
- **per-call cwd 隔离**：每个 agent 调用传 `cwd: <worktree路径>`，独立 worktree 防 git index 冲突
- **cleanup 必跑**：Phase 3 在 `finally` 块，无论 Phase 0-2 成败都执行（防 worktree 泄漏）
- **失败降级**：dev 聚合 merge 冲突 → 跳过 test（测部分代码不如不测），review 仍跑（审已 merge 部分）

### 主 agent 职责边界

主 agent 调 `workflow run execute-full-workflow` 后：
- 不派 subagent（避免认知层逃逸跳过 ensemble——workflow 脚本内 parallel() 机器强制派发）
- 读 workflow return 的 review must_fix + failures + cw 终态
- 对 fail 的 test case ask_user 决策（重跑 vs user-skipped+凭证）
- cw(dev/test) 由 workflow 内每个 agent 完成后渐进式提交（决策 3，非主 agent 中转）
```

## §6 测试校验点

- [ ] T11.1：grep `worktree` + `git worktree add` 或 4 phase
- [ ] T11.2：grep `ADR-029` 回链 + 决策 2 关键词
- [ ] T11.3：`python3 .githooks/validate-skill-yaml.py` frontmatter 合法
