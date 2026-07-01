# 交付物模板：decisions.md

①clarity 创建此空骨架，后续所有阶段 append 决策行。字段定义见 `loop-skeleton.md` Step 1.2 schema（本模板只给可写骨架，不重复字段说明）。

## decisions.md frontmatter

```yaml
---
topic: {topic-slug}
created_at: 2026-XX-XX   # ①clarity 创建日期
---
```

## 决策账本（append-only，一行一条决策）

> 表头与字段顺序固定（check 脚本/下游引用依赖）。`superseded_by` 空列留空；有值时原行 `status` 必须同步改 `revisited`。

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-001 | （一句话决策结论） | （为什么这么定 + 被采纳/被否方案的关键取舍） | `D-不可逆`/`D-可逆` | `ask_user`/`agent-opinionated` | `clarity`/`architecture`/... | `[from: {topic} §{章节}]`（初稿前填 `§TBD`，Step 5a 补实） | `confirmed` | （空，除非被推翻） |

## 示例（仅供参考，创建时删除）：revisit 链 append-only 写法

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-002 | 用事件溯源而非 CRUD | 下游要求完整审计链 | `D-不可逆` | `ask_user` | `architecture` | `[from: demo §4.2]` | `revisited` | D-005 |
| D-005 | 改用 CRUD + 变更日志（成本） | 事件溯源运维成本过高（⑤骨架验证发现） | `D-不可逆` | `ask_user` | `code-arch` | `[REVISIT of D-002] from: demo §9]` | `confirmed` | （空） |

> D-005 是 D-002 的推翻决策：D-002 的 `status` 改 `revisited` + `superseded_by: D-005`；D-005 新行 append 带 `[REVISIT of D-002]` 溯源。原 D-002 **不删**（保审计链）。
