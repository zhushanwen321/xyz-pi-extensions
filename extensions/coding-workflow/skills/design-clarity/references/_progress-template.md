# 交付物模板：_progress.md

①clarity 创建此文件（含 frontmatter 写入 complexity_tier），每阶段结束覆盖更新。结构参照 `loop-skeleton.md`「跨会话续作」。`design_status` tool/CLI 是权威状态机，本文件是其可读快照。

## _progress.md frontmatter

```yaml
---
topic: {topic-slug}
complexity_tier: L2   # ①clarity 判定（L1/L2/L3），驱动全程降级，用户可覆盖
created_at: 2026-XX-XX
---
```

## 正文骨架（每阶段结束覆盖更新）

```markdown
# 设计进度 — {主题}

**当前阶段：** {第 N+1 步名称}（下一步执行）
**主题目录：** `.xyz-harness/{yyyy-MM-dd}-{主题}/`
**复杂度档位：** L{1|2|3}（见 frontmatter）

## 已完成阶段
| 阶段 | 交付物 | 审查 |
|------|--------|------|
| ①澄清需求 | requirements.md (+.html) | ✅ APPROVED |

## 下阶段必读
- 下阶段 SKILL.md（load 对应 skill）
- 本主题全部上游交付物（见上表，均在本目录）

## 不可推翻的决策
- **直接 read `{topic}/decisions.md` 取 status=confirmed 且 classification=D-不可逆 的决策**（权威源，即时维护，不在本文件复制一份——消除双份维护漂移）
```

> **决策一节引用 decisions.md，不复制**——否则两处维护必漂移。进度部分（已完成阶段表）仍由本文件维护。
