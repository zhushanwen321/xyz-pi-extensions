---
verdict: APPROVED
phase: architecture
merged_from: [review-mid-plan-arch.md, review-mid-plan-redteam.md]
---

# Review — Architecture（架构合理性 + 边界 + 红队）

## 结论

system-architecture.md 经 review-fix-loop 第 1 轮收敛（CONVERGED）。架构合理性路 + 红队路联合审查，2 条 must_fix + 4 条 should_fix 全部修复。

## must_fix（已清空）

| 原始发现 | 来源 | 修复 |
|---------|------|------|
| D-2 预填公式 fallback 链不等价（回改场景污染 freeform） `[CROSS-VALIDATED]` | [from review-mid-plan-arch MF-1] | ✅ 改为分流预填（freeform 入口 freeTextValue，comment 入口 commentValue） |
| 自建 parseKey + KeyPressedEvent 复造 SDK 轮子 `[CROSS-VALIDATED]` | [from review-mid-plan-redteam MF-1] | ✅ D-005 复用 SDK parseKey（ask_user 确认），删 parse-key.ts/KeyPressedEvent |

## should_fix（已处理）

- §6 分层图把 parse-key.ts 拔高成「层」 [from review-arch SF-1] → ✅ parseKey 归入 Component 层内部
- AC-1/AC-4 grep 命令错误（handleInput 是 public） [from review-arch SF-2/SF-3] → ✅ 命令修正
- parseKey 覆盖范围未明确 [from review-arch SF-4] → ✅ §7 注明仅编辑器走 parseKey
- BC 漏登 comment 预填 / freeform Enter 清 selectedIndex [from review-rebuild MF-1/SF-1] → ✅ 补 BC-4b/BC-4c

## 保留理由

架构方向正确：parseKey 白名单（复用 SDK）+ draftText 归位 + handleInput 拆分。证伪三连确认 parseKey 是 Component 层协作函数非独立层。Port 清单「无真 port」降级理由成立。BC-1~BC-7 行为契约完整登记，BC-7 变更标注与 requirements 一致。

## 红队 deletion test 结论

核心 special-key 拦截、BC-1/2/3（bracketed paste / code point / 控制字符过滤）删不得。draftText 迁移是长期合理技术债偿还（保留）。UC-4 提示行经 ask_user 确认保留（D-006）。
