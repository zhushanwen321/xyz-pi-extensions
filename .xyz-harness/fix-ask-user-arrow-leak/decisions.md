# 交付物模板：decisions.md

①clarity 创建此空骨架，后续所有阶段 append 决策行。字段定义见 `loop-skeleton.md` Step 1.2 schema（本模板只给可写骨架，不重复字段说明）。

## decisions.md frontmatter

```yaml
---
topic: fix-ask-user-arrow-leak
created_at: 2026-07-09
---
```

## 决策账本（append-only，一行一条决策）

> 表头与字段顺序固定（check 脚本/下游引用依赖）。`superseded_by` 空列留空；有值时原行 `status` 必须同步改 `revisited`。

| id | decision | rationale | classification | confirmed_by | stage | source | status | superseded_by |
|----|----------|-----------|----------------|--------------|-------|--------|--------|---------------|
| D-001 | 修复范围=架构重构（parseKey 白名单 + draftText 归位 + handleInput 拆分），非最小黑名单补丁 | 根因是缺失解析层；黑名单只堵症状，modifier 组合键仍泄漏；用户明确要求「架构层面顺手优化」 | `D-不可逆` | `ask_user` | `clarity` | `[from: fix-ask-user §1 G2]` | `revisited` | D-005 |
| D-002 | parseKey 覆盖 modifier 组合键（alt+x / ctrl+shift+arrow 等），非仅 bare special key | matchesKey 已支持 modifier 前缀解析；不覆盖则 alt+x 仍泄漏可见字符 x，未根治 | `D-不可逆` | `ask_user` | `architecture` | `[from: fix-ask-user §10 D-1]` | `revisited` | D-006 |
| D-003 | 实际泄漏实况确认需全覆盖（Q2 必须覆盖 modifier） | 用户确认 Q2 必须覆盖，间接说明按潜在风险处理 | `K` | `ask_user` | `clarity` | `[from: ask_user Q3]` | `confirmed` | |
| D-004 | handleInput 搭便车拆分为 handleOptionsInput + 纯路由 handleInput | 现有 ~80 行踩 CLAUDE.md 行数上限边缘；与 G2 路由归位天然契合；拆后三 handler 对称 | `D-不可逆` | `ask_user` | `architecture` | `[from: fix-ask-user §10 D-3]` | `confirmed` | |
| D-005 | parseKey 复用 SDK（`@mariozechner/pi-tui` 已导出 `parseKey(data): string\|undefined`），不自建 parse-key.ts + KeyPressedEvent 判别联合 | [REVISIT of D-001/D-002] review-fix-loop 两路独立验证（红队 MF-1 + 需求 MF-2 [CROSS-VALIDATED]）SDK 已有 parseKey，覆盖全部 special key + modifier 组合 + 三套终端协议。自建是复造轮子且违反 §7「不得自己解析终端转义序列」 | `D-不可逆` | `ask_user` | `architecture` | `[REVISIT of D-001/D-002] from: review-redteam MF-1 + review-needs MF-2]` | `confirmed` | |
| D-006 | UC-4 编辑器提示行保留（带 UX） | 用户拍板保留提示行；方向键修复后是 no-op，提示行告知用户 append-only 语义 | `D-不可逆` | `ask_user` | `clarity` | `[from: ask_user 决策B]` | `confirmed` | |
| D-007 | issues P0/P1 划线：#1(parseKey)=P0, #2(draftText)/#3(handleInput拆分)/#4(提示行)/#5(测试套件)=P1 | P0/P1 在 mid-plan 已拍板（D-005 SDK 复用、D-004 拆分、D-006 提示行），无新 D-不可逆争议 | `D-可逆` | `agent-opinionated` | `mid-detail-plan` | `[from: issues.md §P0/P1]` | `confirmed` | |
| D-008 | P3 延后项 #6/#7/#8（bracketed paste 跨 chunk / label 含逗号 / Tab 运行验证） | 均为边角情况，agent 可决延后，不阻塞核心 | `D-可逆` | `agent-opinionated` | `mid-detail-plan` | `[from: issues.md §P3]` | `confirmed` | |
