# 设计进度 — 修复 ask-user 方向键泄漏 + 键码路由重构

**当前阶段：** ⑥执行（coding-execute，下一步执行）
**主题目录：** `.xyz-harness/fix-ask-user-arrow-leak/`
**复杂度档位：** L2（见 frontmatter）

## _progress.md frontmatter

```yaml
---
topic: fix-ask-user-arrow-leak
complexity_tier: L2
created_at: 2026-07-09
---
```

## 已完成阶段
| 阶段 | 交付物 | 审查 |
|------|--------|------|
| ①澄清+架构 | requirements.md + system-architecture.md (+ .html) | ✅ APPROVED（review-fix-loop 1 轮收敛） |
| ②~⑤详细设计 | issues.md + non-functional-design.md + code-architecture.md + code-skeleton/ + execution-plan.md | ✅ APPROVED（review-fix-loop 4 路，F-1 空格 bug 已修） |

## 下阶段必读
- 下阶段 SKILL.md：mid-detail-plan（issues + nfr + code-arch + execution-plan）
- 本主题全部上游交付物（见上表，均在本目录）

## 不可推翻的决策
- **直接 read `{topic}/decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策**（权威源，即时维护，不在本文件复制一份——消除双份维护漂移）
