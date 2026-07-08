---
frame: structure
round: 1
converged: false
gap_count: 2
---

# code-arch Step 2 追踪 — 结构帧（structure）

> 视角：依赖健康（无环 / god object LOC / 分层纪律）。
> 审查人：主 agent（fresh 视角）。

## 审查方法
对照：code-architecture.md §1 工程目录 + §2 包依赖图 ↔ decisions D-009/D-019/D-020/D-014/D-003 ↔ system-architecture §11 grep 验收清单（11 条）+ §5/§7 模块划分。

## Gaps

### SC-1 [K] §2 包依赖图缺 RecordStore→FinalizedMarker/AliveStore 边的标注
- **location**: §2 包依赖图
- **description**: §2 Mermaid 图画了 `store --> finalmk` 和 `store --> alive`（正确，reconstructAll 四分支读 sidecar），但**未在 import 规则文字里显式说明 record-store 依赖 finalized-marker/alive-store 是新增边**。现有 record-store.ts:22 只 import tombstone-store，四分支扩展后需加 import finalized-marker + alive-store。这是正确的新增依赖（reconstructAll 重建需读 sidecar），但 §2「import 规则」只列了 6 条 grep 规则，未单独说明"record-store 新增对 finalized-marker/alive-store 的依赖"。
- **evidence**: record-store.ts:22 当前仅 `import { readCancelledTombstone } from "./tombstone-store.ts"`；§3 record-store.reconstructAll 标了"调 readFinalized/readAliveMarker/isProcessAlive"
- **fix_suggestion**: §2 import 规则补一条说明：record-store 依赖 finalized-marker（readFinalized）+ alive-store（readAliveMarker/isProcessAlive）——这是 reconstructAll 四分支的必要依赖，方向单向（store→叶子模块）。**非 D-不可逆**（信息补充，依赖本身正确）。

### SC-2 [K] session-runner→alive-store 依赖未在 §2 图中体现
- **location**: §2 包依赖图
- **description**: §3 标了 session-runner 在 session 创建后调 `writeAliveMarker`（#12，紧邻 identity entry），但 §2 Mermaid 图**未画 runner→alive 边**。session-runner.ts 现有不 import alive-store，新增 writeAliveMarker 调用需加 import。图中 runner 只画了 →scr 和 →types，漏了 →alive。
- **evidence**: §3 session-runner 表标了"调 alive-store.writeAliveMarker"；§2 图 runner 节点只有 →scr + -.ctx.sdk.-> sdk，无 alive 边
- **fix_suggestion**: §2 Mermaid 图 runner 加 `runner --> alive` 边（writeAliveMarker 调用）。验证无环：runner→alive 是单向（alive 是叶子，不反向 import runner）。**非 D-不可逆**。

## 已验证无 gap 项（CONVERGED 子项）
- ✅ **包依赖无环**：worktree-manager→alive-store 单向（wtm 依赖 alive，alive 是叶子不反向）；store→alive 与 wtm→alive 共享 alive（叶子）无环；runner→scr 单向；store→finalmk 单向。**全图无循环**（§2 已正确画活态/终态单向边）
- ✅ **无 god object**：WorktreeManager ~450 LOC（issues R2 修正后估值，骨架阈值 600 内）；其余新模块 alive-store ~40/FinalizedMarker ~50/SCR ~60 均 small surface。无单模块过大风险
- ✅ **②§11 grep 规则 11 条全对照**：§1/§2/§3 正确体现
  - AC-1 Core 零 Pi 依赖：§1 core/ 标"禁 import pi"，SCR 标零 Pi import ✅
  - AC-2 SCR 零副作用：§1 SCR 标"零 IO"，§3 标"纯函数零副作用零 Pi import" ✅
  - AC-3 STATUS_PRIORITY crashed：§3 record-store STATUS_PRIORITY 加 crashed ✅
  - AC-4 cleanup 配对：§3 WorktreeManager.cleanup 标 remove --force + branch -D 成对 ✅
  - AC-5 finalized GC：§3 session-file-gc.walkAndClean 标加清 .finalized ✅
  - AC-6 reaper=WorktreeManager.scan：§3 index.ts 标 WorktreeManager.scan（非 WorktreeReaper）✅
  - AC-7 无 keepBranch：§3 cleanup 恒 remove+branch-D（D-015）✅
  - AC-8 SdkLike forkFrom+createBranchedSession：§3 types.ts 标 ✅
  - AC-9 collectPatch 先行：§3/§4 finalizeRecord D-017 时序 ⓪在①前 ✅
  - AC-10 无 GitPort：§1/§3 WorktreeManager 有私有 gitRun（D-019）✅
  - AC-11 无 PatchCollector：§1/§3 collectPatch 是 WorktreeManager 方法（D-020）✅
- ✅ **D-009 模块归层**：WorktreeManager/FinalizedMarker/alive-store 归 Runtime（有副作用 git/IO）；SCR 归 Core（纯函数）。D-014 SCR 真纯函数（不调 SDK/IO）✅
- ✅ **变化轴单一**：每目录标注变化轴（§1 表格）

## 收敛判定
**CONVERGED=false**（2 个 K-gap，均为依赖图标注遗漏，非真实依赖错误——依赖方向均正确无环）。回 Step 3 补标注后本帧即收敛。
