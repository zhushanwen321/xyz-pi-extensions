---
entries: 0
phase: nfr
---

# 反哺检查报告 — non-functional-design.md vs 上游（①②③）

## 核对范围

逐上游 .md 核对 NFR 是否引入与已拍板事实/决策矛盾的结论。

## 重点核对结论

### 重点项 1：NFR #6「两级降级链」vs issues.md #6 — 对齐，无矛盾

issues.md #6 口径（:453,467,490）：createBranchedSession 优先（D-018），forkFrom 仅作降级；AC-6.3 验证两级；AC-6.6 是 fork:false 默认 create 路径非降级链。NFR #6 口径（:257-258,571,604）：明确「两级降级 createBranchedSession→forkFrom」，注明「issues.md #6 仅两级，AC-6.3 覆盖」，from-scratch 是 UC-1 替代流程。**完全一致，无需反哺修订 issues.md**。

### 重点项 2：NFR #5 真窗口（①②后③前）vs architecture §5 三分支 — 对齐，无矛盾

architecture §5（:116-129）：三分支「都无→crashed」恒判。NFR #5（:208,212）：真窗口 = ①②后③前，无 .finalized 但磁盘已 done/failed → 三分支「都无」恒判 crashed，不读 recon.status；明确否定原稿「UC-7 降级 recon」兜底。**一致**（不读 recon.status）。NFR 主动揭示 requirements UC-7 异常流程（:192）在三分支下不成立，是合理下游细化，非矛盾。

### 重点项 3：NFR AC 引用 vs issues.md AC — 对齐，无矛盾

缓解项回灌登记表逐条核对（AC-7.4/7.9/4.4/9.4/10.2/12.2/12.4/1.5/8.4/6.3/4.10/4.11/2.2/2.3）：全部编号存在且语义一致，无幽灵 AC 或语义漂移。

## 全量扫描

- **①requirements**：取舍原则/约束引用一致。#5 残余对 UC-7 标注是合理下游细化。无新矛盾。
- **②architecture**：#2 三分支引用章节号正确；#4 D-024 与 §5:133 一致；#7 D-017 时序与 §7 集成点表 + §10 一致。**口径差异（非 NFR 引入）**：architecture §5 Reason 表 crashed reason 固定 "process killed (no finalized marker)"，但 issues.md AC-12.6 区分 "no alive marker"/"pid not alive"。此差异源自 tracing-round-2 B11 修复落在 issues.md AC 层未回灌 architecture §5 Reason 表——NFR #2 引用固定 reason 与 issues.md AC-2.4（基础三分支路径）一致，NFR 自身无矛盾。
- **③issues**：13 issue 全覆盖，方案标记一致。#4 reaper 映射链修正「crashed 非 sidecar」与 AC-4.4 语义一致（NFR 精确化补充）。无新矛盾。
- **decisions.md**：约束引用一致，未标 `[REVISIT]`，D-027 已同步。

## 矛盾清单

无。NFR 修订后与 ①requirements / ②architecture / ③issues 对齐，未引入新事实性矛盾或设计假设被证伪。

## 结论

**pass** — entries:0，无矛盾，无需修订上游 .md，无 D-不可逆决策需 ask_user。

---

**附注（非阻断，供主 agent 参考）**：architecture §5 Reason 表（:85）crashed reason 固定串未随 issues.md #12 四分支扩展（AC-12.6 区分 "no alive marker"/"pid not alive"）更新。此差异源自 tracing-round-2 B11 修复落在 issues.md AC 层未回灌 architecture §5 Reason 表。NFR #2 引用固定 reason 与 issues.md AC-2.4（基础三分支无 .alive 路径）一致，NFR 自身无矛盾。是否回灌 architecture §5 Reason 表反映四分支 reason 区分，由主 agent 视整体一致性策略决定（属 architecture/issues 层面收敛，非本轮 NFR 反哺触发项）。
