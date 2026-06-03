---
verdict: pass
---

# E2E Test Plan — Workflow model-switch 集成

## Test Scenarios

### Scenario 1: scene 驱动模型选择（AC-1）

**Setup:**
- 确认 `~/.pi/agent/extensions/model-switch/model-policy.json` 存在且包含 `scenes.coding`
- 确认当前时间不在 zhipu peak 时段内

**Steps:**
1. 创建 workflow 脚本，内容为 `const r = await agent({ prompt: "echo hello", scene: "coding" }); return r;`
2. 通过 Pi 运行该 workflow
3. 检查 workflow trace 日志中 agent-call 的 model 字段

**Expected:** model 字段为 `zhipu/glm-5.1`（scenes.coding 列表第一个）

### Scenario 2: peak 时段避让（AC-2）

**Setup:**
- 在 peak 时段运行（或 mock 系统时间到 15:00）
- 确认 zhipu plan quota > 50%

**Steps:**
1. 同 Scenario 1 的脚本
2. 运行 workflow
3. 检查 trace 中 model 字段

**Expected:** model 字段为 `opencode-go/ds-flash`（跳过 peak avoid 的 zhipu）

### Scenario 3: 显式 model 覆盖（AC-3）

**Steps:**
1. 脚本 `await agent({ prompt: "echo hello", scene: "coding", model: "minimax/minimax-m3" })`
2. 运行 workflow
3. 检查 trace

**Expected:** model 字段为 `minimax/minimax-m3`，忽略 scene

### Scenario 4: 无 scene 默认行为（AC-4）

**Steps:**
1. 脚本 `await agent({ prompt: "echo hello" })`
2. 运行 workflow
3. 检查 Pi 子进程启动参数

**Expected:** 子进程不携带 `--model` 参数

### Scenario 5: 配置缺失降级（AC-5）

**Setup:**
- 临时重命名 `model-policy.json`

**Steps:**
1. 脚本 `await agent({ prompt: "echo hello", scene: "coding" })`
2. 运行 workflow
3. 恢复配置文件

**Expected:** workflow 正常完成，无 `--model` 参数，日志中有 warn

## Test Environment

- **前置条件:** Pi 已安装，model-switch 和 workflow extension 已加载
- **配置文件:** 需要有效的 `model-policy.json`（v2 格式），包含至少 2 个 provider 的 scenes.coding
- **时间依赖:** AC-2 需要控制时间（mock 或实际等待 peak 时段）
