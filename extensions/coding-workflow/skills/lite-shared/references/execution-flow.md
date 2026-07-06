# 执行流程详解（阶段 A / B / C）

> coding-execute 正文只做阶段路由，本文件是各阶段的**完整操作步骤**。
> 本流程同时服务 lite（plan.md）和 mid/full（execution-plan.md）两种 plan 格式——
> coding-execute skill 内部的机器门（执行收尾门）自动识别格式，Wave/TDD/worktree/test-runner 落盘机制两者通用。
> 进入对应阶段前 read 本文件的对应章节。

## 阶段 A：开发（Wave 并行 + 严格 TDD）

> **[工作习惯] multi-workspace 项目 cwd 提醒**：主 agent 自跑任何项目命令（A5 覆盖率 gate / 阶段 C 收尾验证 / subagent hang 降级自验）前，先确认命令绑定的工作目录。bash 工具 cwd **不跨调用持久**——每条 `cd X && cmd` 的 cd 只在那一条内有效，下一条回到默认。multi-workspace/monorepo 项目命令常分散多层级（lint 在根、test 在子包、dev 在更深层）。**不假设「刚才 cd 过了」**，每条命令显式带目录（如 `cd renderer && npx vitest run`）。implementer 中断后主 agent 接手时尤其注意——继承的 cwd 可能就是错的起点（实测：连续 6+ turn 漏写 cd）。

### A1. 调度 Wave

读 plan.md 的 Wave 表 + 并行组（见 `wave-model.md`）：

- **同并行组的 Wave**（文件无交集、无调用依赖）→ 各建 worktree，同消息派多个 implementer（`wait:false`）并行
- **有 blocked_by 的 Wave** → 等上游完成后再派（串行）
- **单 Wave** → 直接派一个 implementer（`wait:true` 同步）

### A2. 建 worktree（多 Wave 并行时）⚠️ 不可逆操作

```bash
# 为每个并行 Wave 建 worktree（base=当前功能分支，确保同一起点）
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-w1 <base-branch>
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-w2 <base-branch>
# 确认输出 "Worktree 创建完成!" + 记录路径
```

> ⚠️ 不可逆：worktree 创建会切分支。按精确命令执行，base 统一用当前功能分支。

#### worktree 建失败时的降级（A2/B2 通用）

worktree 可能因各种原因建不成（脚本 bug、磁盘、分支冲突、依赖装失败）。**skill 不假设 worktree 100% 成功**——建不成时走显式降级，不即兴发挥：

- **降级触发**：create-worktree 输出错误 / 无 `Worktree 创建完成!` / 目录未生成
- **降级模式**：当前 worktree 跑，但必须约束：
  - 各 subagent 用**工具白名单隔离**（implementer 限定改动文件域，test-runner 无 write 权限防副作用，code-review 只读）
  - 无法文件系统隔离时**串行执行**（无 worktree 隔离的并行有 git index 冲突风险）
- **必须向用户报告降级**（不静默降级）：说明「worktree 建不成，降级为当前 worktree + 权限隔离 + 串行」
- **记录降级原因**进 coding-retrospect（root cause 追溯，是脚本 bug 还是环境问题）

> 降级是可控的退路，不是失败。但静默降级 = 隐藏风险（如 test-runner 的 E2E 副作用污染了 code-review 的只读环境）。

### A3. 派 implementer subagent（严格 TDD）

#### 实现方式选择（subagent 编排 vs 主 agent 直接实现）

默认派 implementer subagent（fresh context 隔离 + worktree 隔离副作用）。仅当**全部**满足以下条件，才允许主 agent 直接实现：

- [ ] 改动 ≤ 150 行且 ≤ 2 文件
- [ ] 主 agent 已 read 全部目标文件（上下文已具备，无需传递）
- [ ] 单一领域内聚（不跨子系统）

> **反向约束**：若该 Wave 含复杂 SFC/模板语法（易出低级语法错，如 defineProps 括号、模板指令拼写），即使满足上述条件也**建议派 subagent**——fresh context 更易 catch 主 agent 因上下文污染漏掉的低级错（实测：主 agent 直接写 SFD 曾丢 defineProps 括号，3 fail 被放大成 8 fail）。

任一不满足 → 必须派 implementer subagent。不要即兴判断。

**单 Wave（wait:true 同步）**：

```
subagent 工具：
  action: "start"
  startParam: {
    agent: "worker",
    wait: true,
    cwd: "<wt-w1 绝对路径>",
    task: """
    实现 Wave W1：<plan.md 该 Wave 的改动文件 + 职责>。
    严格 TDD，按此顺序，不可跳步：
    1. 先写失败测试。用例：
       U1: <输入> → <预期>
       U2: <输入> → <预期>（异常）
       U3: <输入> → <预期>（边界）
    2. 跑测试确认失败（预期 FAIL）
    3. 写最小实现让测试通过
    4. 跑测试确认全绿
    5. git add <本 Wave 改动文件显式路径> + commit（禁 git add -A，防误加 .xyz-harness/ 等无关文件）
    涉及 lint 规则/错误处理/命名约定时，先 grep 项目现有同类写法照抄，不自创
    （如 `grep -rn "no-silent-catch"` 找现有 disable 写法，一次改对）
    只实现 plan.md 列出的用例覆盖范围，不加额外功能。
    """
  }
```

**多 Wave 并行（同消息多个 wait:false）**：

```
同一条消息发起 N 个 subagent（每个 wait:false, cwd=各自 worktree）：
  调用1: agent=worker, wait=false, cwd=wt-w1, task="实现 W1: ...（含 W1 的 U* 用例）"
  调用2: agent=worker, wait=false, cwd=wt-w2, task="实现 W2: ...（含 W2 的 U* 用例）"
两条 start 返回 subagentId 后 STOP（不要轮询，notifier 会唤醒）。
```

> 并行前提：文件影响集无交集。有交集必须串行（wait:true 逐个派）。

### A4. implementer 返回处理

- **DONE**：该 Wave 的 todo 标 completed，进覆盖率检查
- **DONE_WITH_CONCERNS**：读疑虑，涉及正确性先解决，观察性记录后继续
- **NEEDS_CONTEXT**：补上下文重新派
- **BLOCKED**：评估——上下文问题补 context / 能力不足换强模型 / 任务太大拆小 / plan 有误上报用户。**不要原样重试**

### A5. 覆盖率 gate（开发收尾门）

所有功能 Wave 完成后：

```
todo 更新：所有 [W*] 标 completed
跑覆盖率：pnpm --filter <pkg> test -- --coverage（或 plan.md 的 gate 命令）
判定：增量覆盖率 ≥ 60%？
  达标 → [覆盖率] todo 标 completed，进阶段 B
  不达标 → 回对应 Wave 的 implementer 补测试（指出哪部分未覆盖），重跑 gate
```

> 开发收尾 = 单测全绿 + 覆盖率≥60%。不是"代码写完了"。gate 不达标不算收尾。

### A6. 多 Wave 合并 ⚠️ 不可逆操作

各 worktree 完成后二选一（详见 `subagent-dispatch.md`「合并回主分支」）：

**方式 A（集成验证，多 Wave 推荐）**：
```bash
bash ~/.claude/skills/lightmerge-branch/scripts/lightmerge.sh init <project> <base>
bash ~/.claude/skills/lightmerge-branch/scripts/lightmerge.sh add <project> feat/lite-w1
bash ~/.claude/skills/lightmerge-branch/scripts/lightmerge.sh add <project> feat/lite-w2
# 冲突退出码 10 → 解冲突 → continue
```

**方式 B（直接合并，单 Wave 或无冲突）**：各分支走 PR（Create a merge commit），合并后 remove-worktree 清理。

### A7. 早启动 review（多 Wave 可选加速）

> 可选优化，非 [铁律]。多 Wave（≥2）时，某个 Wave 合并到集成分支后，若后续还有未调度的 Wave，立即 background 派 code-review 审该 Wave diff，与后续 Wave 的 implementer 并行。**单 Wave 或已是最后一个 Wave → 不触发**（无重叠对象），直接走 A5 覆盖率 gate → 阶段 B。

```
Wave Wn 合并到集成分支后（A6 方式 A 增量 add）：
  ↓
background 派 code-review（wait:false）审 Wn diff
  ↓
不等 review，回 A1 调度 W{n+1} 的 implementer（review 与实现重叠）
  ↓
review 完成（notifier auto-inject 唤醒）→ 收集 must_fix 清单存着（阶段 B 汇总用，不立即修）
```

派发模板见 `subagent-dispatch.md`「早启动 review（多 Wave 加速）」。

**为什么安全**：code-review 纯只读（tools: read），不改代码、不起副作用，background 跑不污染 git 状态；review 与 implementer 各自独立 worktree 无写入冲突；must_fix 反正要等所有功能 Wave 完成才统一修（阶段 B 失败循环），提前发现不提前改。

## 阶段 B：测试验收（多任务严格执行）

> [铁律] 测试验收不是一个任务。为每条测试用例建独立 todo，逐个验证。

### B1. 建测试验收 todo

```
开发 todo 已全 completed → todo(action='clear') 清空开发期 todo
建验收 todo（E2E 按 mock/real 测试层分组）：
todo(action='add', texts=[
  "[验收] U1: <用例描述> 全绿",
  "[验收] U2: <用例描述> 全绿",
  "...每条 U* 一个 todo，不打包...",
  "[验收] 覆盖率 gate 达标",
  "[验收-mock] E1 mock E2E: <场景> 全绿",
  "[验收-mock] E2 mock E2E: <场景> 全绿",
  "...每条 mock 层 E* 一个 todo...",
  "[验收-real] E1-r real E2E: <场景> 全绿",
  "[验收-real] E3 real E2E: <场景> 全绿",
  "...每条 real 层 E* 一个 todo（无环境的标 [需集成环境] 待 ask_user 决策）...",
  "[验收-mock] 全量单测 + mock E2E 全绿（CI 高频回归基线）",
  "[验收-real] 全量 real E2E 全绿（真实集成兼底，最后）"
])
```

> **每条用例（U*/E*）各自一个 todo，不打包。** 单测也按条拆（不是「U1-U{N} 全绿」打包一条），E2E 按业务用例拆。失败能精确定位到哪条用例，与 coding-execute [铁律]「每条测试用例各自独立 todo」一致。
>
> **E2E 必须按测试层分组**（`[验收-mock]` / `[验收-real]`），不能混成一堆。mock 层快、CI 跑，real 层慢、环境敏感——分层建 todo + 分层回归，失败能区分「逻辑问题」还是「集成问题」，real 层环境故障不携掣 mock 层高频回归。分组依据是 plan.md E2E 清单的「测试层」列（见 `test-case-schema.md` 核心原则四）。
> 验收 todo 全部 isVerification 性质（必须 completed，不可跳过）。todo 支持 isVerification 参数则标记；否则在描述注明 [验收] 强制执行。

### B2. 建 worktree + 派 test-runner ‖ code-review ensemble（并行隔离）⚠️ 不可逆操作

> **code-review ensemble（默认启用）**：code-review 是主观判断任务（评估质量、找问题），单路 review 有遗漏率（5 维度里某个维度弱、某文件没细看）。派 2 个 reviewer 各自聚焦不同维度，must_fix 清单并集——直接攻击单路遗漏。reviewer 纯只读（tools: read），**2 个 reviewer 共享同一个 review worktree 并行只读完全安全**（无写入、无 git index 冲突），worktree 数量不增加。

> **与 A7 早启动 review 的衔接**：若阶段 A 已早启动 review（单路，只审单个 Wave diff）且已完成 → 这里只派 test-runner，收集 A7 的 must_fix 清单并入下方 2 路 ensemble 结果；若 review 未早启动（单 Wave）或未完成 → 维持下方做法（test-runner ‖ 2 路 code-review ensemble 并行）。

```bash
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-test <base-含全部改动>
bash ~/.claude/skills/create-worktree/create-worktree.sh feat/lite-review <base-含全部改动>
```

同消息派 3 个后台 subagent（test-runner 1 个 + reviewer 2 个共享 wt-review，详见 `subagent-dispatch.md`）：

```
调用1（test-runner，cwd=wt-test）：
  agent: <test-runner>, wait: false, cwd: <wt-test>
  task: "分层跑测试并报告结果（只读，不改代码）：
  **mock 层（隔离层）**：
  1. 单测：pnpm --filter <pkg> test（或项目实际命令），报告 pass/fail 数 + 每个失败的 file:line
  2. 覆盖率：pnpm --filter <pkg> test -- --coverage，报告增量覆盖率数值
  3. mock 层 E2E：跑 plan E2E 清单中测试层=mock 的用例（按其执行方式）
  **real 层（真实层）**：
  4. real 层 E2E：跑 plan E2E 清单中测试层=real 的用例（需真实后端/数据环境）
     - 能真跑（worktree 起本地 mock 后端 / docker-compose / 本地集成环境）→ 跑并报 pass/fail
     - 确无环境 → **不要自标「手动通过」**，status 记 'fail' + evidence 注明 'no env: <原因>'。主 agent 收到 fail 后 ask_user 决策（重跑 vs user-skipped+凭证，见 B3 用户豁免）
  对照 plan.md 用例清单逐条判定，**必须落盘结构化报告**到
  `.xyz-harness/{topic}/changes/test-results.json`（schema 见下方），
  这是阶段 C 执行收尾机器门的强制门数据源——自由文本报告无法机器核对。
  **分层报告**：mock 层 U*/mock E*/覆盖率 pass/fail + real 层 real E* pass/fail。"

#### test-results.json 落盘 schema（test-runner 必须产出）

```json
{
  "results": [
    {"id": "U1", "status": "pass", "evidence": "vitest run: 3 passed"},
    {"id": "E1", "status": "pass", "evidence": "npx playwright test e1: passed"},
    {"id": "E1-r", "status": "pass", "evidence": "本地集成环境跑通"},
    {"id": "E1-r", "status": "user-skipped", "evidence": "无真实后端",
     "user_confirm_ref": "turn N 用户 ask_user 确认跳过"}
  ],
  "summary": {"total": 4, "passed": 3, "user_skipped": 1}
}
```

字段规范：
- **id**：与 plan.md 用例 ID 一致（U*/E*/E*-r）
- **status**：`pass` | `fail` | `user-skipped`
  - **禁止** `manual` / `blocked` / `skipped`——这些是 AI 自标降级，执行收尾机器门一律判 FAIL
  - `fail` 涵盖所有未通过（逻辑挂/跑不了/无环境）；主 agent 收到 fail 后 ask_user 决策（重跑 vs user-skipped+凭证）
  - `user-skipped` 必须带 `user_confirm_ref`（用户确认凭证），否则 FAIL
- **evidence**：命令输出摘要 / 失败 file:line（机器可追溯）
- **user_confirm_ref**：仅 user-skipped 必填——记录用户在哪确认跳过（turn 号 / ask_user 引用）

> [铁律] test-results.json 是执行收尾机器门的唯一数据源。test-runner 不落盘 = 执行收尾机器门无从核对 = goal 无法 complete。

调用2（reviewer-正确性组，cwd=wt-review）：
  agent: "reviewer", wait: false, cwd: <wt-review>
  task: "只读审查 git diff，聚焦【业务逻辑正确性 + 类型安全 + 边界条件】，出 must_fix/should_fix/nit"

调用3（reviewer-质量组，cwd=wt-review）：
  agent: "reviewer", wait: false, cwd: <wt-review>
  task: "只读审查 git diff，聚焦【测试覆盖 + 代码规范 + 边界条件】，出 must_fix/should_fix/nit"
```

> **差异化（ensemble 的关键，否则 N 路盲区高度相关无增益）**：2 路 reviewer 认知方向不同——正确性组问「跑起来对不对」（与实现同向），质量组问「写得好不好」（与实现正交）。**边界条件是两路都跑的重叠维度**——它是 5 维度里最易漏且代价最大的一类（空值/并发/最大值），对它叠加冗余（两路独立找边界问题，并集）。

三条 start 返回后 STOP，notifier 唤醒后汇总。

> **为什么隔离**：test-runner 跑 E2E 有副作用（起服务/写文件），reviewer 纯只读。test-runner 独立 worktree 保证 review 看到干净代码态，测试副作用不污染 review。**2 个 reviewer 共享 wt-review**：两者都纯只读（tools: read），无写入无副作用，并行读同一份代码完全安全，不需各建 worktree。

### B3. 结果汇总 + todo 更新

> **real 层 fail 处理（用户豁免权）**：test-runner 把确无环境真跑的 real 用例记 `status: fail` + evidence 注明 'no env: <原因>'。主 agent 收齐后，对每条 fail **必须 ask_user** 由用户显式决定：
> - 用户确认跳过 → 改 status 为 `user-skipped` + 填 `user_confirm_ref`（记用户确认引用）
> - 用户要求真跑 → 主 agent 提供环境方案（起本地 mock 后端 / docker-compose）重派 test-runner
>
> **禁止 AI 自决把 fail 改成 manual/blocked/pass**——降级决定权在用户。见 `test-case-schema.md` 核心原则四。

```
test-runner：逐条用例 pass/fail + 覆盖率数值（已落盘 test-results.json）
reviewer-正确性组：must_fix/should_fix/nit 清单
reviewer-质量组：must_fix/should_fix/nit 清单

2 路 reviewer 清单并集去重（按「文件:行 + 问题」去重），合并清单写入 `.xyz-harness/{topic}/changes/review-merged.md`（frontmatter 含 `review_ensemble_overlap`）：
  - 两路都报同一问题 → [HIGH-CONFIDENCE]（明显问题，必修）
  - 仅一路报 → [NEEDS-VERIFY]（边缘问题，主 agent 复核确认后转必修或丢弃）
  - 趋同检测：2 路重合度 > 80%（都报同样几个问题）→ 该次改动 review 收敛，
    frontmatter 记 `review_ensemble_overlap: high`（说明该 Wave review 单路已够，未来同类可降级单路）；
    重合度低 → 记 `review_ensemble_overlap: low`。
    **此字段是 coding-retrospect「ensemble 趋同数据复盘」的输入——落盘到 changes/ 才能被 retrospect grep 消费，否则是死数据。**

逐条更新验收 todo：
  pass 的用例 → todo 标 completed
  fail 的用例 → todo 保持 pending（进失败循环）
```

> **review 并集不替代 test-runner**：review 找的是代码质量问题（逻辑/类型/边界/规范），test-runner 找的是测试失败。两者正交——review 全过不等于测试全绿，反之亦然。失败循环（B4）同时处理两者。

### B3.5 失败定位纪律（派 implementer 修复前必做）

失败循环的第一次修复最容易重蹈覆辙——拿着未验证的诊断假设直接改实现。**派 implementer 修复前，先确认诊断假设成立（顺序不可反）：**

1. **先验证检测方法本身，再改实现**。别拿一次成功的观测就当真理——mock 环境巧合有效 ≠ 普遍有效。对每条「功能没生效/行为不对」的判断，先 dump 实际状态（getComputedStyle / 输出实际 DOM 属性 / 打印实际返回值）核对，确认观测手段能区分「功能在」和「功能不在」，再下结论。
   > 实测案例：诊断脚本用 mock 环境巧合有效的选择器 `[data-radix-popper-content-wrapper]` 检测浮层，真实环境一直 false，误判「浮层没弹」，改了 5+ 轮实现逻辑才发现**检测方法本身就错**（浮层早弹了，是 z:1100 的 fixed div）。代价全在诊断阶段的 turn。
2. **沿数据/消息链路逐层打点定位断点**。跨进程/跨层的问题别只看两端。正面手法：发送方 push log → 传输层 route log → 接收方 recv log，三层精确定位「发了但中间没到 / 到了但没处理」，直接锁定断点在哪一层，避免在错误方向（如改接收方订阅逻辑）空转。
3. **根因归类抽象到模式层，不只修当前路径**。根因要写成「所有同类路径都需 X」，作为后续同类型 Wave 设计的前置输入——而非「这条路径需 X」。
   > 实测案例：Wave 1 把时序根因归到「selectSession 这条路径」，Wave 2 预创建 session 遇**完全相同**的 broadcast 时序问题二次返工。真因是「任何 broadcast 时机早于订阅建立的路径都会丢」——归类停在具体路径 = Wave 间根因无法传播。

> 诊断假设未实测验证就采信是反复出现的同构失败模式（mock 成功当真理 / handoff 事实声明盲信）。事实型假设只有实测能证伪，逻辑推导不出。详见 wave-model.md「Wave 间根因传播」。

### B4. 失败循环（限 3 轮）

```
全 pass + 覆盖率达标 + review 无 must_fix？
  → 是：所有验收 todo completed → 进阶段 C（goal complete）
  → 否：round++（初始 1）
       round ≤ 3：
         派 implementer 修复（cwd=对应功能 worktree）
         task 含：失败用例 ID + 失败详情 + review must_fix 清单
         修复后重跑阶段 B（B2 重新派 test-runner + review）
       round > 3：Stagnation
         暂停，报告用户：「连续 3 轮未全绿，剩余：<清单>。
           可能：plan 设计缺陷 / 超出 lite 范围 / 需人工介入。
           建议：调整 plan / 升级 full / 人工排查。」
         不再自动重试
```

> 3 轮上限防止无限循环。连续不收敛说明问题不在实现层，需人工判断。

### B5. 副作用隔离注意

- 有副作用的 E2E（起服务、写文件、改 DB）**只在 test-runner 的 worktree 跑**
- 2 路 reviewer 纯只读（tools: read），无副作用，共享 wt-review 保证看到干净代码态
- E2E 需启动被测服务时，test-runner 的 worktree 负责；不在主会话起（污染）

## 阶段 C：收尾 ⚠️ 不可逆操作

全部验收 todo completed：

**0. 执行收尾机器门（goal complete 前必做，[MANDATORY]）**——coding-execute skill 内部的机器门核对 test-results.json 是否覆盖 plan 全部用例（自动识别 lite plan.md 的 U*/E* 或 mid/full execution-plan.md 的 T{UC}.{N}）。该门由 coding-execute skill 内部实现，agent 不直接调用 TS 函数；agent 的职责是确保 test-results.json 已正确落盘（见 B2），调用 goal complete 时由 skill 内部机器门自动核对：
- **PASS** → 进下方语义审查 + goal complete
- **FAIL** → **禁止 goal_control(complete)**。报告指出的逃逸路径必须先补：
  - 缺用例（mock/real 无结果）→ 重派 test-runner 补跑
  - AI 自标 manual/blocked → 走 B3 用户豁免（ask_user）改 user-skipped+凭证，或真跑
  - mock 层非 pass → 回阶段 A 修复
  修完重新触发执行收尾机器门直到 PASS。

> 这是执行阶段唯一的机器硬门，对齐 lite-plan 的 CW gate 机器检查（plan 阶段）。此前执行阶段零 gate，AI 能直接跳过 E2E 调 goal complete——本门堵死该路径。

**0b. 语义/契约变更审查（goal complete 前必做）**——逐条核对本次改动是否引入：
- 新的状态可达路径（之前不可达的状态/分支现在可达）
- 改变了既有函数的副作用语义（延迟→立即、同步→异步、单次→多次等）
- 改变了数据生命周期（创建/销毁/缓存时机）

任一为是 → 本次不是纯「小功能」：补 ADR 记录决策，或提示用户升级 full 工作流，再 complete。全否则继续。
> 实测案例：预创建 session 改变了「延迟 create」语义、让 landing 态 branch 链路变可达——典型藏在「小功能」里的架构语义变更，范围守门（plan 前/execute 启动前）拦不住，全程无触发器，直到复盘才记录。收尾门补这个洞。

```
1. goal_control(action='complete',
     evidence='单测 {U}条全绿 + 覆盖率 {X}% + E2E {E}条全绿 + review 无 must_fix',
     completedTasks=<总数>)
2. todo(action='clear')  # 清空验收 todo
3. 清理 worktree（cd 到 workspace 根）：
   bash ~/.claude/skills/remove-worktree/remove-worktree.sh feat/lite-w1
   bash ~/.claude/skills/remove-worktree/remove-worktree.sh feat/lite-test
   bash ~/.claude/skills/remove-worktree/remove-worktree.sh feat/lite-review
4. 提示用户：下一步 /skill:coding-retrospect 复盘；
   若 plan 来自 mid-detail-plan / full-execution-plan（有设计 deliverable），再 /skill:coding-closeout 沉淀设计结论进长期文档（lite 无设计 deliverable，跳过 closeout）
```

> remove-worktree 前必须 cd 到 workspace 根（含 `.bare/` 的目录）。
