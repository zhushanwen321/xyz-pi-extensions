# Clarification 模型结构

`clarification.md` 是收敛循环的核心产出物——spec 的结构化骨架。所有场景追踪基于此模型。

## 五个维度

| 维度 | 内容 | 来源 |
|------|------|------|
| **Entities** | 系统中的核心实体、关键字段、关系 | code + discussion |
| **Operations** | 系统支持的操作、执行者、输入输出、副作用 | code + discussion |
| **State Machines** | 每个实体的合法状态与转换 | code + discussion |
| **Actors & Permissions** | 参与者及其权限边界 | code + discussion |
| **Constraints** | 性能/安全/兼容等非功能约束 | code + user |

**标注来源规则**：模型中每个事实必须标注来源——`code`（已从代码验证）、`discussion`（来自用户讨论）、`assumption`（假设，需后续验证并标 `[UNVERIFIED]`）。

## 完整文件结构

产出文件：`{topicDir}/clarification.md`

```markdown
# Clarification: {Topic}

## Meta
- Round: {N} | Model Version: {V} | Open Gaps: {N} | Resolved: {N}
- Complexity: {L0/L1/L2} — 评估 reasoning: {...}
- Stagnation Count: {0-3}

## Requirement
{用户原始需求}

## Selected Approach
{选定的方案} — {推理过程}

## Decomposition Map
{Round 1 产出的需求/技术拆解图，含清晰度和优先级标注。格式见 `references/requirement-decomposition.md`}

## Entities
| ID | Name | Key Fields | Relationships | Source |
|----|------|-----------|---------------|--------|
| E01 | ... | ... | ... | code/discussion |

## Operations
| ID | Name | Actor | Input | Output | Side Effects | Source |
|----|------|-------|-------|--------|--------------|--------|
| OP01 | ... | ... | ... | ... | ... | code/discussion |

## State Machines
### E01: {Entity Name}
| From | To | Trigger | Guard | Side Effects |
|------|----|---------|-------|--------------|
| ... | ... | ... | ... | ... |

## Actors & Permissions
| ID | Name | Permissions | Source |
|----|------|------------|--------|
| A01 | ... | ... | code/discussion |

## Constraints
| ID | Type | Description | Priority | Source |
|----|------|-------------|----------|--------|
| C01 | perf/security/compat/... | ... | P0/P1/P2 | code/user |

## Deferred Items
{Defer-Ext 项：标记 `[DEFERRED-EXT]`，记录扩展点设计要求，留给 plan 阶段}

| Aspect | Sub-type | What's Deferred | Extension Point Required |
|--------|----------|-----------------|--------------------------|
| ... | ... | ... | ... |

## Scenarios
{5 个视角的场景追踪输出，格式见 scenario-tracing.md}

## Gap Tracker
{格式见 gap-management.md}

## Resolved Decisions
| Decision | Options | Selected | Reasoning |
|----------|---------|----------|-----------|
| ... | ... | ... | ... |
```

## 模型构建与更新

**Round 1 骨架：** 创建 clarification.md，写入 Requirement、Selected Approach、Decomposition Map（由 `requirement-decomposition.md` 的 Step 2 产出）。

**首次构建五维度（Round 2）：**
1. 从代码中提取事实（Facts）：现有实体、接口、状态、枚举值
2. 从 Round 1 讨论中提取知识（Knowledge）：用户描述的行为、约束
3. 填入五个维度，每个事实标注来源

**更新（Round 3+）：**
- 用 gap 解决结果更新对应维度
- 新发现的实体/操作追加到模型
- 被推翻的假设标记并修正，`assumption` 验证后改为 `code` 或标 `[UNVERIFIED]`

模型版本号（Model Version）的递增规则：

- **Round 1 结束创建骨架**：`model_version = 1`（骨架包含 Requirement、Selected Approach、Decomposition Map，五维度还是空的）
- **每次完成一轮 Step 6-10 完整循环（外层循环）**：`model_version += 1`
- **内层循环（Step 8↔9 单轮内解决 gap）不递增 version**——只有更新模型维度（Step 6）才算新一轮

收敛条件要求 `model_version ≥ 2`，意味着至少经过一轮 Step 6-10 的完整迭代，不能只用 Round 1 骨架直接声称收敛。
