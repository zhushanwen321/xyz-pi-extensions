---
verdict: pass
---

# Use Cases — Skill & Agent Usage Tracker

### UC-1: 分析 skill/agent 使用模式，优化配置

- **Actor**: 用户（通过 Pi agent）
- **Preconditions**:
  - usage-tracker extension 已安装且运行过至少一个 session
  - `~/.pi/agent/usage-stats.json` 包含累积统计数据
  - usage-analyzer skill 已安装
- **Main Flow**:
  1. 用户向 Pi 提问："分析一下我的 skill 使用情况"或"哪些 skill 我从没用到过"
  2. Pi agent 加载 usage-analyzer skill
  3. Agent 读取 `~/.pi/agent/usage-stats.json`
  4. Agent 按 skill 提供的 4 个分析维度（频率排序、零使用检测、关联分析标注未来扩展、时间趋势标注限制）分析数据
  5. Agent 按决策建议模板（删除候选、整合候选、保留、新增候选）输出结构化报告
  6. 用户根据报告决定是否删除/整合/新增 skill 或 agent
- **Alternative Paths**:
  - **AP-1: 数据文件不存在** — Agent 提示用户"尚无使用数据，需要先正常使用 Pi 一段时间后再分析"
  - **AP-2: 数据文件为空（skills 和 agents 都是 {}）** — Agent 提示"extension 可能未正确安装或尚无 skill/agent 被调用"
- **Postconditions**:
  - 用户获得 skill 和 agent 的使用频率排行、零使用列表和管理建议
- **Module Boundaries**:
  - Extension（usage-tracker）负责数据采集，不参与分析
  - Skill（usage-analyzer）负责分析框架，不参与数据采集
  - 数据文件是两者的唯一接口
- **AC Coverage**: UC-1 → AC-1 (数据来自 skill 计数), AC-2 (数据来自 agent 计数), AC-5 (skill 引导分析)
