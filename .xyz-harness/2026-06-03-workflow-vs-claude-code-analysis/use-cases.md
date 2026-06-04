---
verdict: pass
---

# 业务用例 — Workflow model-switch 集成

## UC-1: 批量代码审查自适应模型

- **Actor**: 用户（运行 workflow 脚本）
- **Preconditions**:
  - model-policy.json 已配置（v2 格式），包含 `scenes.coding`
  - workflow extension 已加载
- **Main Flow**:
  1. 用户编写 workflow 脚本，在 `agent()` 调用中声明 `scene: "coding"`
  2. 运行 workflow
  3. Orchestrator 收到 agent-call 消息，检测到 `scene` 参数
  4. 调用 `resolveModelForScene("coding")`
  5. advisor 查询 scenes.coding → 候选列表 → quota + peak 判断 → 返回最优模型
  6. Pi 子进程以推荐模型启动，执行审查任务
- **Alternative Paths**:
  - **AP-1: Peak 时段** — 步骤 5 中首个候选被 avoid → 跳过，选择下一个可用候选
  - **AP-2: 全部 avoid** — 所有候选都不可用 → 使用 Pi 默认模型，info 日志
  - **AP-3: 配置缺失** — model-policy.json 不存在 → warn 日志，使用默认模型
- **Postconditions**:
  - workflow 正常完成（无论模型推荐是否成功）
  - trace 中记录实际使用的模型
- **Module Boundaries**: workflow(orchestrator) → model-switch(advisor) → quota-providers(cache)
- **Spec AC 覆盖**: AC-1, AC-2, AC-5

## UC-2: 显式模型覆盖

- **Actor**: 脚本作者
- **Preconditions**: 无（不依赖 model-switch 配置）
- **Main Flow**:
  1. 脚本中调用 `agent({ prompt: "...", model: "minimax/mimo-v2.5-pro" })`
  2. Orchestrator 收到 agent-call，检测到 `model` 字段
  3. 跳过 scene/advisor，直接使用指定模型
  4. Pi 子进程以 `--model minimax/mimo-v2.5-pro` 启动
- **Alternative Paths**: 无
- **Postconditions**: 使用脚本指定的模型，trace 中记录该模型
- **Module Boundaries**: workflow(worker-script) → workflow(orchestrator) → AgentPool(spawn)
- **Spec AC 覆盖**: AC-3, AC-6

## UC 覆盖映射表

| UC | 覆盖 AC |
|----|---------|
| UC-1 | AC-1, AC-2, AC-5 |
| UC-2 | AC-3, AC-6 |
| *(全局)* | AC-4（无 scene 默认行为，两个 UC 都隐含覆盖） |
