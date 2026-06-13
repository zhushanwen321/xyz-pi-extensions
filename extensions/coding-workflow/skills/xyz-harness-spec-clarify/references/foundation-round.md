# Round 1: Foundation

Round 1 只执行一轮，建立事实基础、理解需求、选定方案。产出喂给 Round 2+ 的收敛循环。

```
Step 1: Quick Overview        → 建立事实基础
Step 2: Clarifying Questions  → 理解目的、范围、约束
Step 3: Approach Selection    → 2-3 方案 + 用户选择
```

## Step 1: Quick Overview

与 brainstorming skill 相同。快速浏览项目结构、依赖、README，建立基本上下文。< 30 秒完成。

## Step 2: Clarifying Questions

[MANDATORY] 一次问一个问题，按以下层级递进：

**Layer 1: Purpose & Scope（2-3 questions）**
- 解决什么问题？谁受影响？
- 成功标准是什么？如何判断"完成"？
- 明确不做什么（scope boundary）。

**Layer 2: Core Behavior（3-5 questions）**
- 主要用户流程是什么？
- 与现有系统如何交互？（触发 on-demand scan）
- 有哪些硬约束？（时间、性能、兼容性）

**Layer 3: Decisions & Constraints（2-3 questions）**
- 已经做出的、不可更改的技术决策？
- 最可能出错的地方？
- 有哪些需要权衡的取舍点？

**何时停止提问：** 你能用具体的步骤描述完整的解决方案而无需猜测。

**技巧：**
- 用 `ask_user` tool 做结构化提问（多选项优于开放问题）
- 用 Quick Overview 的发现跳过基础问题（"我看到项目用 Pinia，这个功能复用同样的模式吗？"）
- 用户回答涉及具体模块时，dispatch on-demand scan

## Step 3: Approach Selection

基于 Step 2 的理解，提出 2-3 个方案：

1. **给出推荐方案 + 推荐理由**
2. 每个方案列出 trade-off（不是优缺点列表，是具体的取舍：选 A 意味着放弃 B）
3. 方案差异应该在**架构层面**，不是命名或格式层面

用户选择后，记录：
- 选定方案 + 推理过程
- 被排除方案 + 排除理由
- 方案中的开放问题（将作为 Round 2+ 的种子 gap）

---

## 独立使用（不通过 coding-workflow）

如果不在 coding-workflow 中使用本 skill：

1. 用户描述需求 → AI 加载本 skill
2. 按 Round 1 → Round 2+（见 `convergence-loop.md`）→ Spec Generation 执行
3. Gate 步骤（原 Step 10）改为自检：
   - 重新读 `clarification.md`，检查每个视角是否覆盖了所有核心操作
   - 检查 Gap Tracker 中是否有 P0/P1 open gap
   - 如果有 → 继续解决；如果无 → 完成
4. 产出 `spec.md`
