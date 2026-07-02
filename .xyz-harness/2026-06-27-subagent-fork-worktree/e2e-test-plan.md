---
topic: subagent-fork-worktree
purpose: E2E 测试说明（通过实际调用 subagent 工具验证运行时行为，非单元测试）
---

# Subagent fork + worktree E2E 测试说明

> 测试目标是 subagent 工具的**运行时行为**，不是项目源码。禁止改项目源码，临时产物写 `/tmp/subagent-e2e/`。

## 前置条件

- 在**干净 working tree 的 git 仓库**启动 pi（worktree 隔离依赖 `git worktree add`，脏树被拦）
- fork 测试需 parent session 已 flush 至少一条 assistant message
- 查状态用 `/subagents`；patch 路径在 `<sessionsDir>/<branch>.patch`
- 嵌套递归测试（A 组）建议用 claude-sonnet 级模型。注意：glm-5.2 会忠实遵守 agent systemPrompt，**feat-subagent-enhance 时代遗留的反递归禁令已在本 feat 删除（D-031）**，现仅由 MAX_FORK_DEPTH 兜底。注意：只有持有 `subagent` 工具的 agent（general-purpose、worker 等未限制 tools 白名单的）能嵌套 spawn；专用 agent（researcher/reviewer/planner/scout/oracle/context-builder）的 tools 白名单不含 subagent，物理上无法 spawn（这是有意的领域约束，非禁令残留）

## 关键约束（源码确认）

- `worktree:true` **必须**配 `fork:true`，否则抛错（`subagent-service.ts:218`）
- worktree 分支前缀固定 `pi-sub-<recordId>`；patch 写在 worktree 之外（不被 cleanup 删）
- fork 深度上限 `MAX_FORK_DEPTH=10`（`session-context-resolver.ts`），第 11 层抛 `ForkDepthExceededError`
- sync subagent **不进并发池**（D-032），嵌套不会因 maxConcurrent 死锁；background 仍进池（默认 4，排队不超时）
- fork 子 agent 的 env block 含 `Fork depth: N/10`（D-030），可感知自身层级
- session_start 触发 reaper 扫 `pi-sub-*` 孤儿

---

## A 组：fork 上下文继承（UC-1）

| 用例 | 命令要点 | 预期 |
|------|---------|------|
| **A1** 基本继承 ✅核心 | parent 先植入事实（"SECRET=42"）→ `fork:true, task:"我之前说的 SECRET 是？只回数字"` | 子 agent 答 42（证明拿到 parent 历史）；不报 "Cannot fork: source empty" |
| **A2** 源为空 → hard fail | 新 parent 无 assistant message → 立刻 `fork:true` | 抛 "Cannot fork: source session file is empty or invalid"，finalizeFailed，主循环不崩 |
| **A3** 嵌套深度上限 | 构造 fork 链达第 11 层（见下方递归测试） | 第 11 层抛 "fork depth 10 >= 10"，按 finalizeFailed 收尾 |
| **A4** depth 可观测 ✅核心 | `fork:true` 启动子 agent，task:"报告你的 Fork depth 值" | 子 agent 能读出 env block 里的 `Fork depth: N/10`（D-030 验证） |

### 递归嵌套测试（验证 D-007 + D-030）

depth 注入落地后，子 agent 自己看 env block 就知道层级，prompt 不必让 parent 转述 depth。

**T-nest-1：递归累加（验证深度可驱动）**
```
task: "调用 subagent 发起子 agent，提示词原样转发本段。
       你被明确授权嵌套调用 subagent（见工具说明 Nested spawning 段）。
       先读你的 Fork depth，若已达 3 则直接返回 1 不再 spawn；
       否则返回 (子 agent 返回值) + 1。"
fork: true, wait: true, model: anthropic/claude-sonnet-4-5
```
预期：形成 3 层嵌套，parent 返回 3。`/subagents` 可见多个 record，forkDepth 逐层 +1。

**T-nest-2：深度上限拦截（验证 MAX_FORK_DEPTH=10）**
把 T-nest-1 阈值改 11，预期第 11 层抛 `ForkDepthExceededError`，finalizeFailed，主循环不崩。

## B 组：worktree 文件隔离（UC-2）

| 用例 | 命令要点 | 预期 |
|------|---------|------|
| **B1** 基本隔离 ✅核心 | `fork:true, worktree:true, task:"创建文件 e2e-marker.txt"` | 文件写进 worktree；parent 目录无该文件；worktree 已清 |
| **B2** worktree 无 fork → 拒绝 | `worktree:true`（不传 fork） | 抛 "worktree:true requires fork:true"；不半创建 worktree |
| **B3** 脏树 → 拦截 | parent 先弄脏 tracked 文件 → `fork:true, worktree:true` | 创建被拦，给 commit/stash 提示 |
| **B4** 并发不冲突 | 同消息发 2 个 `fork:true,worktree:true,wait:false` | branch/path 互异，都 done，无冲突 |

## C 组：fork + worktree 组合（UC-3）

| 用例 | 命令要点 | 预期 |
|------|---------|------|
| **C1** 组合基本 ✅核心 | parent 植入 SECRET → `fork:true,worktree:true,task:"写 ans.txt 存我的 SECRET"` | 子 agent 既答出 SECRET（fork）又写在 worktree（隔离） |
| **C2** session 落主命名空间 | C1 后 `/subagents` list | record 可见；session 在 `subagents/<encoded-主cwd>/sessions/`（D-004） |

## D 组：patch 回传与清理（UC-4）✅核心

| 用例 | 命令要点 | 预期 |
|------|---------|------|
| **D1** 有改动→非空 patch+清理 | B1/C1 跑完后查 | `<sessionsDir>/pi-sub-<id>.patch` 非空；`git worktree list` 无残留；patch 可 `git apply --check` |
| **D2** 无改动→空 patch | `fork:true,worktree:true,task:"只读 README 不修改"` | patch 为空；worktree+branch 仍正常删除 |
| **D3** apply patch 闭环 | 取 D1 patch → parent `git apply <patch>` | 文件变更出现在 parent 工作目录（worktree 模式实际交付路径） |

## E 组：reaper 孤儿清扫（UC-5）✅核心

| 用例 | 命令要点 | 预期 |
|------|---------|------|
| **E1** kill -9 后重启清扫 | 启动 worktree 长任务→`kill -9 <pi-pid>`→重启 | session_start reaper 清掉孤儿 worktree+branch；`git worktree list` 干净 |
| **E2** 活态不被误清 | 有运行中的 worktree subagent 时重启 | reaper 判活跳过；活态 worktree 仍在 |

## F 组：crashed 状态标记（UC-7）✅核心

| 用例 | 命令要点 | 预期 |
|------|---------|------|
| **F1** kill -9→crashed | 启动 sync subagent→执行中 `kill -9`→重启→list | status=**crashed**（非 done 非 failed，新增 ExecutionStatus） |
| **F2** 正常完成重启仍 done | 正常跑完（写了 .finalized）→重启→list | 仍 done（.finalized 生效，不误判 crashed） |

## G 组：可见性（UC-6）

| 用例 | 命令要点 | 预期 |
|------|---------|------|
| **G1** worktree record 可见 | B1 完成后 `/subagents` | record status=done，含 patchFile 字段（非空） |

---

## 验收口径

| 等级 | 标准 |
|------|------|
| ✅通过 | 验证点全中 |
| ⚠️部分 | 主流程对但有偏差（如脏树提示文案不理想） |
| ❌失败 | 崩溃/静默失败/状态错（crashed 误判 done、patch 丢失、worktree 残留、活态被误清） |

**必须全绿的核心路径**：A1、A4、B1、C1、D1、D3、E1、F1、T-nest-1。

其中 **T-nest-1 / A4** 是 D-030（fork depth 注入 LLM）的直接验证——若失败说明 depth 未正确注入 env block 或 description 授权文案未生效。

## 旧 prompt 作废说明

根目录 `subagent-e2e-test-prompt.md` 按已废弃的 backgroundId/query API 编写（T2-T13），与新 action 模型（start/list/cancel）不符，已作废。本文件为替代。
