---
review_round: 1
route_count: 4
review_ensemble_overlap: low
---

# review-fix-loop 第 1 轮汇总（mid-plan）

4 路并行 reviewer 完成（需求完整性 / 架构合理性 / 禁读重建 / 红队）。

## must_fix 并集去重

| # | 发现 | 来源 | 类型 | 交叉验证 | 处理 |
|---|------|------|------|---------|------|
| MF-1 | D-2 预填公式 `freeTextValue ?? commentValue ?? ""` fallback 链不等价（回改场景污染 freeform） | 架构 MF-1 + 禁读重建 MISSING-1 | F | `[CROSS-VALIDATED]` 两路独立命中 | ✅ 已修：改为分流预填 |
| MF-2 | 自建 parseKey + KeyPressedEvent 复造 SDK 轮子（pi-tui 已导出 parseKey） | 红队 MF-1 + 需求 MF-2 | 过度设计 | `[CROSS-VALIDATED]` 两路独立命中 | ✅ 已修：D-005 复用 SDK（ask_user 确认） |
| MF-3 | AC-2.3 把 enter/escape 混进「全部 no-op」自相矛盾 + modifier 指数空间无采样 | 需求 MF-1 | F | 单路 | ✅ 已修：special key 分两类 + 采样矩阵 |
| MF-4 | UC-4 提示行 YAGNI | 红队 MF-2 | 过度设计 | 单路 | ask_user 确认保留（D-006） |
| MF-5 | BC 清单漏登 comment 进入时预填 commentValue | 禁读重建 MF-1 | F | 被 MF-1 修复吸收 | ✅ 已修：补 BC-4c |
| MF-6 | §7/§8/§7 约束三方矛盾（禁止自建解析 vs 本地实现 parse） | 需求 MF-2 | F | 随 MF-2 消解 | ✅ 已修：§8 改为复用 SDK |

## should_fix 并集（已处理）

| # | 发现 | 来源 | 处理 |
|---|------|------|------|
| SF-1 | §6 分层图把 parse-key.ts 拔高成「层」 | 架构 SF-1 | ✅ parseKey 归入 Component 层内部 |
| SF-2 | AC-1/AC-4 grep 命令错误（handleInput 是 public） | 架构 SF-2/SF-3 | ✅ 命令修正 |
| SF-3 | parseKey 覆盖范围未明确 | 架构 SF-4 | ✅ §7 注明仅编辑器走 parseKey |
| SF-4 | BC 漏登 freeform Enter 清 selectedIndex | 禁读重建 SF-1 | ✅ 补 BC-4b |
| SF-5 | UC-3 方向键措辞（现状泄漏 vs 修复后 no-op） | 禁读重建 SF-2 | ✅ 已修 |
| SF-6 | Tab 消费状态标注错误（已实现标成候选） | 禁读重建 SF-3 | ✅ 已修 |
| SF-7 | G3 迁移漏列 question-view 参数链 | 需求 SF-1 | ✅ G3.2 + 数据流图补 |
| SF-8 | AC-1.3 测试数 181→180 | 需求 SF-2 | ✅ 已修 |
| SF-9 | UC-3「未提交草稿保持」是新行为非等价 | 需求 SF-3 | ✅ UC-3 措辞限定等价范围 |

## nit（已处理关键项）

- N-1 不变式措辞统一（U+0020）— 架构 N-1：✅
- N-2 BC-1 与 D-1 执行顺序歧义 — 架构 N-2：✅ BC-1 补顺序说明
- N-3 泳道图 editorText→draftText — 架构 N-3：✅
- N-4 §4 不变式 ⟺→⟹ — 架构 N-4：✅
- N-5 敏感级别 低→中 — 需求 N-2：✅

## CONVERGED 判定

所有 must_fix 已修复或经 ask_user 拍板（D-005/D-006）。无残留 D-不可逆 must_fix。**CONVERGED**。
