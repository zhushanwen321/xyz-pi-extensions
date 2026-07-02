---
frame: 测试闭环审计（execution）
round: 1
---

# 追踪 Round 1 — 测试闭环审计（execution）

> fresh-context subagent 审计（Group B）。主读 execution-plan.md 每 Wave「覆盖用例 ID」+「测试验收清单」，交叉验证 code-architecture.md §6 + non-functional-design.md 回灌表。

## 审计结论
- **Wave 用例并集 vs test-matrix 全量**：FAIL — 并集 32 条，缺 **T2.4 / T2.6 / T6.1 / T6.2 共 4 条**（只在清单出现，无 Wave 覆盖段落认领）
- **验收清单完整性**：PASS — 清单 36 条 = ⑤§6 全量，双列齐全
- **④9 条代码测试缓解项闭环**：PASS — 9 条全在映射表，对应用例均有 Wave 归属
- **④性能混沌缓解项归属**：PASS — 0 条（性能混沌=0，无独立 perf Wave）

## 用例覆盖矩阵（Wave × 用例）
| Wave | 覆盖用例 ID |
|------|-----------|
| Wave 1 | T7.8 |
| Wave 2A | T6.3（部分） |
| Wave 2B | T1.4 / T3.1,T3.2（部分） |
| Wave 2C | T7.2,T7.3（标记读写依赖） |
| Wave 2D | T2.1 / T2.2 / T2.3 / T4.1 / T4.2 / T4.3 / T5.1（部分）/ T5.2 / T5.3 |
| Wave 2E | T6.3 |
| Wave 3A | T1.1 / T1.2 / T1.3 / T1.5 / T1.6 / T3.4 |
| Wave 3B | T7.1 / T7.2 / T7.3 / T7.4 / T7.5 / T7.6 / T7.7 |
| Wave 4 | T3.1 / T3.2 / T3.3 / T4.4 / T4.5 |
| Wave 5A | T2.1（部分）/ schema 字段 |
| Wave 5B | T5.1 / T5.4 |
| Wave 6 E2E | T2.5 / T5.4 / T1.1 / T2.1 / T4.1 / T7.5 |

**并集（去重）**：T1.1-T1.6 / T2.1-T2.3 / T4.1-T4.5 / T5.1-T5.4 / T6.3 / T7.1-T7.8 = **32 条**。

## 遗漏用例（4 条，零 Wave 认领）
- **T2.4**（UC-2 边界：嵌套 worktree .git 检测，首版禁止）— 清单标 Wave 2D/unit，但 Wave 2D 覆盖段落漏列
- **T2.6**（UC-2 并发：两 worktree 并发 recordId 唯一不冲突）— 清单标 Wave 2D/integration，Wave 2D 覆盖段落漏列
- **T6.1**（UC-6 正常：fork/worktree record list 可见）— 清单标 Wave 1+4，两 Wave 覆盖段落均漏列
- **T6.2**（UC-6 边界：crashed record list 显示 status=crashed）— 清单标 Wave 1+3B，两 Wave 覆盖段落均漏列

多余：无。时序图 alt/else 异常分支（T1.2/T2.2/T4.3/T5.2）4 条全覆盖。

## 发现的 gap

### K-Gap-1: 4 条用例（T2.4/T2.6/T6.1/T6.2）无 Wave 覆盖认领，测试闭环断链
- 类型: K（认知缺口）
- 位置: Wave 2D/1/4/3B「覆盖的 test-matrix 用例 ID」段落
- 问题: 清单标了归属 Wave，但对应 Wave 覆盖段落与验收标准均未列入。反向不成立：清单用例未必在 Wave 覆盖段落。Wave 6 验收时若按 Wave 覆盖段落建测试映射，这 4 条被漏写，导致「清单全绿」假象。
- 建议修法: 对应 Wave 覆盖段落补认领：
  - Wave 2D 补 T2.4（嵌套 .git 检测拒绝）/ T2.6（两 worktree 并发不冲突）
  - Wave 1 补 T6.1/T6.2 部分（list 投影类型 externalInstance+crashed 字段编译）
  - Wave 4 补 T6.1 部分（fork/worktree record list 可见端到端）
  - Wave 3B 补 T6.2 部分（crashed record 四分支重建后 list 显示）

### K-Gap-2: T2.5 清单标 e2e，与⑤§6 来源 B 强制 integration 不一致
- 类型: K（层级声明漂移）
- 位置: execution-plan.md 清单 T2.5 行（e2e）vs code-architecture.md §6 来源 B（integration）
- 问题: ⑤§6 来源 B 明确 T2.5「node_modules 软链」强制层级 = integration，⑥清单改 e2e 未说明理由，缺 integration 层归属会导致 phase-test gate 漏跑。
- 建议修法: 清单 T2.5 测试执行层改为 `integration+e2e`（与 T1.1/T2.1/T4.1 同形态），Wave 2D integration 测试补 T2.5 断言（node_modules/.bin 存在），Wave 6 保留 e2e。

## 维度通过声明
- [x] 验收清单用例 ID 集合 = ⑤test-matrix 全量（36 条匹配）
- [x] 清单双列（归属Wave+执行层）完整
- [x] ④9 条代码测试缓解项全闭环
- [x] ④性能混沌缓解项 = 0
- [x] 末尾验收 Wave blocked_by 全功能 Wave
- [ ] Wave 用例并集 = ⑤test-matrix 全量（FAIL：32 条，缺 4 条 — K-Gap-1）
