---
verdict: pass
---

# Use Cases — spec-clarify skill 改造

## 覆盖映射表

| UC | 覆盖 Spec AC | 说明 |
|----|-------------|------|
| UC-1 | AC-1, AC-3, AC-4 | 简单需求走完整流程，subagent 发现 gap，F 类二次确认 |
| UC-2 | AC-2, AC-4 | 多轮收敛，独立 subagent 复核判定收敛 |
| UC-3 | AC-3 | F 类误报被主 agent 二次确认过滤 |
| UC-4 | AC-5 | 验证无 L1/L2、无两层循环等旧机制 |

## UC-1: 简单需求走完整流程（主场景）

- **Actor**: 开发者（主 agent + 独立 subagent + 用户）
- **Preconditions**: 用户提出"给订单列表加导出 Excel 按钮"
- **Module Boundaries**: SKILL.md（路由）+ subagent-tracing.md（追踪）+ gap-management.md（分类）

**Main Flow:**
1. 主 agent Quick Overview（读 package.json + README，< 30s）
2. 主 agent 交互提问（ask_user）：导出触发方式、格式、范围等能聊清的
3. 主 agent 写 spec 初稿 + 轻量 clarification.md
4. 主 agent 派独立 subagent（fresh 上下文）读初稿+源码，跑 5 视角追踪
5. subagent 返回 gap 列表：导出范围（K）、大文件处理（D）、失败重试（D）、现有 export 工具复用（F）
6. 主 agent 处理 gap：
   - F（现有 export 工具）→ 二次确认代码，发现可复用 → 不问用户，直接采用
   - K（导出范围）→ 直接问用户"全部订单还是当前筛选？"
   - D（大文件、失败）→ 给方案对比问用户
7. 主 agent 更新 spec + clarification.md
8. 主 agent 派第二个独立 subagent 复核（Step 5）→ 无新 gap → CONVERGED
9. 主 agent 整理 frontmatter，调用 coding-workflow-gate(phase=1)

**Alternative Paths:**
- Step 8 复核发现新 gap → 回 Step 6 继续处理，直到收敛
- 连续 3 轮不收敛 → Stagnation 强制收，未解决 gap 标 [UNRESOLVED]

**Postconditions**: spec.md（verdict: pass）+ clarification.md 产出

## UC-2: 中等需求多轮收敛

- **Actor**: 开发者
- **Preconditions**: 用户提出"做一个优惠券系统"

**Main Flow:**
1-3. 同 UC-1（主 agent 交互提问 + 写初稿）
4. 第一轮 subagent 追踪 → 发现 8 个 gap（券状态机、叠加互斥、核销流程、失效回收等）
5. 主 agent 逐个处理（F/K/D 分流），问用户 5 个问题
6. 更新 spec → 第二轮 subagent 复核 → 发现 3 个新 gap（用户回答触发的新问题）
7. 处理新 gap → 第三轮复核 → 无新 gap → CONVERGED

**验证 AC-2**: 收敛由独立 subagent 的复核判定（Step 5），不靠主 agent 自我判断。

## UC-3: F 类误报被过滤

- **Actor**: 独立 subagent + 主 agent
- **Preconditions**: subagent 追踪 Data Lifecycle 视角

**Main Flow:**
1. subagent 发现 F gap："代码里有 `partial_refund` 方法，退款是否支持部分退款？"
2. 主 agent 收到 gap 列表，对该 F gap 二次确认
3. 主 agent 查看代码，发现 `partial_refund` 是已废弃的旧实现（有 @deprecated 标记）
4. 主 agent 否定该 gap → 丢弃，不问用户
5. 不打扰用户，避免基于废弃代码的错误提问

**验证 AC-3**: F 类二次确认过滤误报，避免浪费用户时间。

## UC-4: 旧机制零残留

- **Actor**: 验证脚本
- **Preconditions**: 所有 task 完成

**Main Flow:**
1. 运行 Task 9 Step 2 的旧机制残留检查
2. 确认以下关键词在 skill 文件中零出现：
   - complexity-assess / L0/L1/L2
   - requirement-decomposition / Decomposition Map
   - 两层循环 / 内层循环 / 外层循环
   - NEEDS_USER / model_version / gap-analysis 维度
   - DEFERRED-EXT / P0/P1/P2 / Gap Tracker

**验证 AC-5**: 范围控制，无过度工程。
