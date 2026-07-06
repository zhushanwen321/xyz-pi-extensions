# ADR-029: 全流程 Workflow 接管 coding-execute（dev+test）+ per-call cwd + worktree 编排

## Status: Proposed

## Context

### 起因：P1 痛点「小任务跳过 test-runner / code-review ensemble」

retrospect.md（news-query-preload）记录：主 agent 对小任务（2 文件 ~60 行）判断"派 subagent 编排开销 > 收益"，跳过了 `[MANDATORY]` 的 test-runner + code-review ensemble，直接自跑 pytest + 自填 test-results。

**根因**：coding-execute SKILL 的 `[MANDATORY]` 是文字约束，靠 AI 认知层遵守。AI 用"任务小"自我合理化跳过——这是认知层的逃逸，文字约束挡不住。

handoff 文档原始方案是"加 SKILL 铁律 + nextAction guidance 强化"，但讨论中发现：**workflow 的确定性脚本能提供更强的机器层强制力**——一旦 AI 调 `workflow run`，脚本内的 `parallel()` 必派 agent，AI 在脚本内部无法跳过。

### 演进：从「只接管 test」到「全流程（dev+test）接管」

初版设想是 workflow 只接管阶段 B（test + review），dev 仍由主 agent 用 subagent + worktree。但讨论中确认了关键架构事实：

- **coding-execute 已同时服务 lite 和 mid**（SKILL.md 明确"plan.md 或 execution-plan.md"）
- **mid = 外层 workflow（clarify + detail）套着内层 lite workflow（dev + test + retrospect）**
- dev 和 test 共享同一套 TDD + worktree + test-runner + 机器门链路

既然要做，一步到位接管 dev + test 比只接 test 更完整——强制力闭环覆盖整个执行阶段。

### 三个必须先解决的阻塞点

全流程 workflow 比"只接 test"多出三个硬阻塞，本 ADR 一并决策：

1. **workflow 和 subagents 是两条独立执行链**——workflow 的 `agent()` 走 `SubprocessAgentRunner`（spawn `pi --mode json` 子进程），subagents 的 `service.execute()` 走进程内 `createAgentSession()`。两条链各自独立，**都不支持 per-call cwd**。
2. **per-call cwd 是 worktree 隔离的前提**——dev 阶段多 wave 并行 implementer 各自改不同文件，需独立 worktree 防 git index 冲突；test/review 也需 worktree 隔离副作用。当前所有 agent 都跑在主 session cwd。
3. **cw(dev/test) 状态机调用脱离 workflow 上下文**——workflow 跑在 Worker 线程，内部 `agent()` 是无状态 pi 子进程，访问不到主 agent 的 CW topic session，不能写 `_cw.db`。

## Decision

### 决策 1：per-call cwd 改造（两条链独立改）

#### Chain A — pi-subagents per-call cwd

**现状**：`SessionRunnerContext.cwd` → `createAgentSession`/`ResourceLoader`/`SessionManager`/`buildEnvBlock` 全链路已支持 cwd，但 cwd 是 `SubagentService` 的进程级字段（`this.cwd`，`session_start` 注入），所有 subagent 跑同一 cwd。

**改动**（4 文件）：
| 文件 | 改动 |
|------|------|
| `src/types.ts` `ExecuteOptions` | 加 `cwd?: string`（optional，缺省回退 `service.cwd`） |
| `src/runtime/subagent-service.ts` `buildSessionRunnerContext(opts)` | 用 `opts.cwd ?? this.cwd` 覆盖 ctx.cwd |
| `src/tools/subagent-actions.ts` `StartHandlerInput` | 加 `cwd?: string` |
| `src/tools/subagent-tool.ts` `SubagentParams.startParam` schema | 加 `cwd: Type.Optional(Type.String())` |

**隔离安全性**：
- `SessionManager.create(cwd, subagentSessionDir)` 已按 cwd 建独立 session 目录（`getSubagentSessionDir` 用 `encodeCwd` 编码），多 cwd 天然隔离
- `branchCache` 是 `Map<cwd, branch>`，已按 cwd 缓存，多 cwd 并发安全
- 无新增共享状态，无隔离风险

#### Chain B — pi-workflow agent() cwd

**现状**：`AgentCallOpts` 无 cwd 字段；`buildArgs` 只构建 `--model/--skill/--append-system-prompt/prompt`；`runPiProcess` 的 `spawn` 第 3 参不传 cwd（继承 workflow 进程目录）。

**改动**（4 文件）：
| 文件 | 改动 |
|------|------|
| `src/engine/models/types.ts` `AgentCallOpts` | 加 `cwd?: string` |
| `src/infra/pi-runner.ts` `runPiProcess()` `spawn()` | 第 3 参 options 加 `cwd: opts.cwd`（undefined 时继承默认） |
| `src/infra/pi-runner.ts` `buildArgs()` | 无需改（cwd 走 spawn options，不依赖 pi CLI `--cwd` flag） |
| `src/infra/worker-script-builder.ts` `agent()` | `knownFields` 加 `cwd`，透传到 postMessage |

**隔离安全性**：workflow Worker 线程内 spawn 多个 pi 子进程到不同 cwd，各子进程独立，无共享状态冲突。`concurrency-gate` 管并发槽位不管 cwd，不受影响。

### 决策 2：worktree 生命周期归 workflow 内建（原生 git，不依赖 .bare）

**方案对比**：
| 方案 | 优点 | 缺点 |
|------|------|------|
| 主 agent 预建 worktree 传路径 | workflow 职责单一 | 割裂流程，主 agent 仍需懂 worktree 编排，强制力闭环有缺口 |
| **workflow 内建（采用）** | 全流程自包含，主 agent 只调一次 workflow run | 需处理失败降级、清理 |

**关键约束**：现有 `create-worktree.sh` 强依赖 `.bare` bare repo workspace 结构（`find_workspace_root` 找 `.bare/`）。目标项目（如 Stock）未必是 `.bare` 结构，直接调用会失败。

**决策**：workflow 脚本内用**原生 `git worktree add`**（`git worktree add <path> -b <branch> <base>`），不依赖 `create-worktree.sh`。这是 git 原生命令，任何 git 仓库都支持。清理用 `git worktree remove <path>`。

**workflow 结构**（4 phase）：
```
Phase 0: worktree-setup
  读 plan.json waves + testCases
  → 按并行组算出需要的 worktree 数（dev 每 wave 组一个，test 一个，review 一个）
  → spawn git worktree add 建 worktree
  → 记录路径清单（失败则 throw，已建的留给 cleanup）

Phase 1: dev waves（二维数组调度）
  for each devWave in devWaves:        // wave 间串行
    parallel(wave.cases.map(case =>     // wave 内全并行（plan 已确认无依赖/无资源冲突）
      agent({ cwd: case.worktree, task: "实现 + TDD + commit", schema: {commitHash, ...} })
    ))
  → 收集所有 commitHash

Phase 2: test + review（并行，不同 worktree）
  parallel([
    ...testWaves.flatMap(wave => wave.cases.map(case =>   // 每 case 1 agent
      agent({ cwd: testWorktree, task: "跑该 case", schema: {status, actual, ...} })
    )),
    agent({ cwd: reviewWorktree, task: "review 维度A" }),  // 2 路 reviewer
    agent({ cwd: reviewWorktree, task: "review 维度B" }),
  ])
  → 收集 test-results + review must_fix

Phase 3: worktree-cleanup（finally 块，必跑）
  spawn git worktree remove <每个 worktree>
  → 失败不阻断 return（记录 cleanup 失败清单）
```

**失败处理**：
- Phase 0 建 worktree 失败 → throw，workflow abort，return 已建清单
- Phase 3 cleanup 在 `finally` 块，无论前面成败都跑
- cleanup 失败（如 worktree 有未提交改动）→ 不 throw，记录到 return 的 `cleanup_failures`，主 agent 提示用户手动清理

### 决策 3：workflow 是纯执行器，不碰 cw 状态机

**边界划分**：
```
主 agent:
  cw(create) → cw(plan/clarify/detail) → 调 workflow run execute-full-workflow
                                            ↓
  workflow（Worker 线程，纯执行器）:           ↓ 不碰 _cw.db，不调 cw tool
    Phase 0 worktree-setup                   ↓
    Phase 1 dev waves (commit)               ↓
    Phase 2 test + review                    ↓
    Phase 3 worktree-cleanup                 ↓
    return { commits, testResults, reviewMustFix, cleanupFailures }
                                            ↓
  主 agent 收 return:
    cw(action=dev, tasks=[{waveId, commitHash}, ...])
    cw(action=test, cases=[{caseId, actual, ...}, ...])
```

**为什么这样切**：
- workflow Worker 线程的无状态 pi 子进程访问不到主 agent 的 CW topic session，不能写 `_cw.db`
- cw(dev/test) 的状态机校验（GitValidator、judgeByExpected、gatePassed）需要主 session 上下文
- 主 agent 只做"调 cw + 传 return 数据"，不做"派 agent"——派 agent 的强制力来自 workflow 内脚本不可跳过

**强制力闭环**：主 agent 一旦调 `workflow run execute-full-workflow`，dev + test 全程必跑（脚本内 `parallel()` 必派，无分支绕过）。workflow 不碰状态机（职责清晰），主 agent 不派 agent（避免认知层逃逸）。

### 决策 4：test 调度字段进 plan.json（lite + mid 同 schema）

**背景**：当前 `LitePlanSchema.testCases` 和 `MidDetailSchema.testCases` 都是扁平数组，无执行顺序依赖、无资源冲突分组。workflow 的二维数组调度无数据可读。

**新字段**（与 dev 的 `WaveSeed.dependsOn/parallelGroup` 同名同义，对称结构）：
| 字段 | 类型 | 解决问题 |
|------|------|---------|
| `dependsOn: string[]` | 可选，默认 `[]` | **执行顺序依赖**（用例间数据状态依赖，如 E3 依赖 E1 建的数据）→ workflow 拓扑排序 |
| `parallelGroup: string` | 可选 | **资源冲突规避分组**（同 chrome profile / 同 DB 表 / 同端口）→ 同组可并行，跨组串行 |

**wave 构造算法**（workflow 读 plan.json 后）：
```
1. 拓扑排序 testCases（按 dependsOn）
2. 同 parallelGroup 的连续用例 → 打包进同一 wave（并行）
3. 无 parallelGroup → 各自独占一个 wave（串行）
4. wave 间串行执行，上游任一 fail → abort 下游（依赖链断）
产出二维数组 testWaves[][]，供 workflow 调度
```

**Store 迁移**：`SCHEMA_VERSION` 3→4，`test_case` 表加 `depends_on TEXT`(JSON) + `parallel_group TEXT` 两列。

**plan skill 指导**：lite-plan / mid-detail-plan 的测试设计步骤加"测试调度设计"子步骤，要求 agent 设计完用例后标注每条的 `dependsOn` + `parallelGroup`。

### 决策 5：砍除 pending-env 状态

**来源**：commit `03698ebf5`，原意区分"AI 自标 blocked（逃逸）"和"test-runner 诚实上报没环境"。

**砍除理由**：没环境跑不了 = 执行失败 = `fail`。用户豁免权体现在 **fail 后的决策**（重跑 vs user-skipped），不需为"没环境"预造中间态。`pending-env` 是 over-engineering——增加状态机复杂度（agent 要判 fail vs pending-env，机器门专门处理它，主 agent 专门 ask_user），无实际收益。

**简化后状态**：
| status | 含义 | 机器门 |
|--------|------|--------|
| `pass` | 真跑通过 | ✅ |
| `user-skipped` + `user_confirm_ref` | 用户放行不跑 | ✅（当 pass） |
| `fail` | 跑挂 / 跑不了 / 任何没通过 | ❌ → 主 agent ask_user 决策 |

## Consequences

### 正面

- **强制力闭环**：dev + test 全程机器强制，AI 调了 workflow 就必走完，认知层逃逸（"小任务跳过"）被堵死
- **上下文聚焦**：每 case 1 agent，agent 上下文极小（只跑 1 条），解决"大测试集 1 个 agent 上下文爆炸、注意力分散"
- **架构对称**：dev 有 wave 调度（`WaveSeed.dependsOn/parallelGroup`），test 也有同构调度（`TestCase.dependsOn/parallelGroup`），plan 阶段用同一套心智模型
- **状态简化**：砍 pending-env 后，test 状态机从 4 态（pass/fail/user-skipped/pending-env）简化为 3 态（pass/fail/user-skipped）
- **per-call cwd 能力下沉**：subagents + workflow 都支持后，未来任何需要 worktree 隔离的场景都能用（不只 CW）

### 负面

- **跨 3 包改动**：pi-subagents（Chain A）+ pi-workflow（Chain B）+ pi-coding-workflow（schema + workflow 脚本 + skill 文档），改动面大，需协调发布
- **worktree 副作用风险**：`git worktree add` 失败 / cleanup 失败会留下孤儿 worktree。靠 finally 块 + return cleanup_failures 兜底，但不 100% 可靠（如进程被 SIGKILL）
- **workflow 内失败处理复杂**：dev wave 失败、test wave 失败、worktree 建失败、cleanup 失败——多种失败路径，workflow 脚本要显式处理（不像主 agent 能即兴判断）
- **retrospect.md 问题3 的 workflow 引擎 bug**：1ms abort bug 跨 repo（pi-workflow）未根治。subprocess-agent-runner 的 stderr 盲点已修，但 abort 路径仍有风险。在已知有缺陷的引擎上建关键路径，需监控

### 实现顺序

1. **Chain A（subagents per-call cwd）**——内核已就绪，改动小，可独立测试 + 发布
2. **Chain B（workflow agent() cwd）**——依赖 Chain A 的设计模式但独立实现
3. **砍 pending-env + plan.json 加 dependsOn/parallelGroup**——schema + 文档 + store migration（v3→v4）
4. **写 execute-full-workflow 脚本**——全流程（worktree setup / dev waves / test+review / cleanup）
5. **改 coding-execute SKILL**——阶段 A+B 指导改为"调 workflow run"，保留 retrospect/closeout 主 agent 执行

### 风险与缓解

| 风险 | 缓解 |
|------|------|
| worktree 孤儿（进程 SIGKILL） | return cleanup_failures + 主 agent 提示用户；长期加 heartbeat（subagents extension） |
| workflow 引擎 abort bug | 关键路径用 `wait:true`（hang 时主 agent 同步阻塞可见）；监控 workflow run 日志 |
| 跨包发布不同步 | Chain A/B 先发布（向后兼容，cwd 是 optional 字段），CW workflow 脚本最后上 |
| plan agent 不填 dependsOn/parallelGroup | SKILL 加 MANDATORY 自检 + CW plan gate 校验（schema 层字段 optional 但 gate 可强制要求 E2E 用例必填） |

## Alternatives considered

### Alternative 1：只接管 test（P1-only），dev 仍主 agent

**否决理由**：dev 阶段没有机器强制力，AI 仍可能在 dev 阶段跳过 TDD / worktree 隔离。且 worktree 改造（决策 1）无论如何都要做（test 也需 worktree 隔离副作用），不如一步到位。

### Alternative 2：用 SKILL 铁律 + nextAction guidance 强化（handoff 原方案）

**否决理由**：文字约束挡不住认知层逃逸（AI 用"小任务"自我合理化）。作为补充层保留，但主力靠 workflow 机器强制。

### Alternative 3：workflow 内调 cw tool（碰状态机）

**否决理由**：需给 workflow 子进程传 topicId + 让 cw tool 支持跨进程 db 访问，大改 CW 架构。且 workflow 子进程的 cw 调用无法获得主 session 的 gate 校验上下文。决策 3 的"纯执行器"边界更清晰。

### Alternative 4：per-call cwd 只改 subagents，workflow 用 prompt cd 指令过渡

**否决理由**：prompt cd 不可靠（agent 可能不严格遵守）。且 dev 阶段多 implementer 并行改不同文件，cd 指令无法替代真正的 worktree 文件系统隔离（git index 冲突是物理层的）。两条链都要改才彻底。

## Open questions

1. **mid 路径的 dev Wave 绑定 test-matrix**：mid 的 `execution-plan.md` 已把 test-matrix 用例 ID 绑到 dev Wave（`wave-template.md`）。全流程 workflow 化后，mid 的 test 调度是"跟 dev Wave 走"还是"独立 test-wave"？倾向：mid 的 dev Wave 信息编码进 `testCases.dependsOn/parallelGroup`，test 阶段统一用独立 test-wave（与 lite 对称）。
2. **worktree 并发上限**：dev 多 wave 组 + test + review 可能同时建 5+ worktree。需设上限或分批建。
3. **cw(dev) 渐进式提交**：当前 cw(dev) 支持渐进式（长 N = 批量 commitHash）。全流程 workflow return 所有 commitHash 后，主 agent 一次性调 cw(dev) 还是分批？倾向一次性（workflow 已等全部 dev 完成）。
