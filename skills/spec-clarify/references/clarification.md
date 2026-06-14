# clarification.md 轻量格式

clarification.md 是主 agent 在 Step 2 交互提问后产出的轻量记录。它不是强制五维度表格，只是记录已知信息和需求拆解的载体。

## 格式

clarification.md 没有强制结构。推荐格式：

```markdown
# Clarification — {需求标题}

## 已知信息
- {从对话和 Quick Overview 得到的确认信息}
- {从源码验证的事实，标注来源}

## 需求拆解
- {核心功能点 1}
- {核心功能点 2}

## 待追踪（交给独立 subagent）
- {主 agent 觉得清楚但没系统验证的部分}
```

## 为什么不强制五维度

5 视角的追踪产出（`tracing-round-{N}.md`）本身就是"模型"。clarification.md 只是追踪的**输入材料**，不需要再抽象一层强制结构。

过重的结构会让简单需求写 clarification.md 变成负担，违背"简单需求也适用"的目标。

## clarification.md 的生命周期

| 阶段 | 内容变化 |
|------|---------|
| Step 2（主 agent 写初稿）| 创建：已知信息 + 需求拆解 |
| Step 4（主 agent 处理 gap 后）| 更新：已解决的 gap 记录到已知信息 |
| Step 6（spec 定稿）| 可选保留作为 spec 的附录，或归档 |

clarification.md 是工作产物，不是最终交付物。最终交付物是 spec.md。
