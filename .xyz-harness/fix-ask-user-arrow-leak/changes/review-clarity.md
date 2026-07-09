---
verdict: APPROVED
phase: clarity
merged_from: [review-mid-plan-needs.md, review-mid-plan-rebuild.md]
---

# Review — Clarity（需求完整性）

## 结论

requirements.md 经 review-fix-loop 第 1 轮收敛（CONVERGED）。需求完整性路 + 禁读重建路联合审查，2 条 must_fix + 4 条 should_fix 全部修复。

## must_fix（已清空）

| 原始发现 | 来源 | 修复 |
|---------|------|------|
| AC-2.3 special key 清单与 pi-tui 不一致 + modifier 无采样矩阵 | [from review-mid-plan-needs MF-1] | ✅ special key 分两类（no-op 集合 vs 有语义键）+ AC-2.4 补 18 用例采样矩阵 |
| G2.1/§8/§7 三方矛盾（自建 parse vs SDK 已有） | [from review-mid-plan-needs MF-2] | ✅ D-005 复用 SDK parseKey，§8 改为复用表述 |

## should_fix（已处理）

- G3 迁移漏列 question-view.ts 参数链 [from review-needs SF-1] → ✅ G3.2 + 数据流图补
- AC-1.3 测试数 181→180 [from review-needs SF-2] → ✅
- UC-3「未提交草稿保持」是新行为非等价 [from review-needs SF-3] → ✅ 措辞限定
- UC-3 方向键措辞（现状泄漏 vs 修复后 no-op）[from review-rebuild SF-2] → ✅

## 保留理由

需求目标树（G1~G4）结构完整，AC 可验证。UC-4 提示行经 ask_user 确认保留（D-006）。D-001~D-006 决策账本清晰，无未决项。
