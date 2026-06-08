---
verdict: pass
---

# Use Cases — Workflow Agent Discovery

## UC-1: Workflow 脚本引用 Review Agent

- **Actor**: coding-workflow 的 workflow 脚本
- **Preconditions**: pi 已安装，`@zhushanwen/pi-coding-workflow` npm 包已安装且包含 `agents/*.md` 文件
- **Main Flow**:
  1. Workflow 脚本执行 `agent({ agent: "review-taste", prompt: "Review src/index.ts" })`
  2. Worker thread 将 `{ agent: "review-taste", prompt: "..." }` 发送给主线程
  3. 主线程 `handleAgentCall` 从 AgentRegistry 查找 "review-taste"
  4. 找到 → 将 systemPrompt 写入临时文件
  5. `buildArgs()` 追加 `--append-system-prompt /tmp/pi-workflow/agent-prompt-{uuid}.md`
  6. pi 子进程启动，agent 的 system prompt 作为额外上下文注入
  7. 子进程退出 → 临时文件删除
- **Postconditions**: Review 结果返回给 workflow 脚本，临时文件已清理
- **Module Boundaries**: Worker thread（参数传递） → Orchestrator（agent 解析 + 临时文件） → AgentPool（参数构建 + 子进程启动）
- **AC 覆盖**: AC-2.1, AC-2.2, AC-3.1

## UC-2: 用户自定义 Agent 覆盖包内 Agent

- **Actor**: 开发者
- **Preconditions**: npm 包中有 `review-taste.md`，用户在项目 `.pi/agents/` 创建同名文件
- **Main Flow**:
  1. `session_start` 触发 `AgentRegistry.discoverAll()`
  2. 先扫描 npm 包路径 → 缓存 package 版 review-taste
  3. 后扫描项目路径 → 缓存 project 版 review-taste（覆盖）
  4. Workflow 脚本调用 `agent({ agent: "review-taste", prompt: "..." })`
  5. `resolve("review-taste")` 返回 project 版本
- **Alternative Path**: 项目路径无同名文件 → 返回 package 版本
- **Postconditions**: 用户自定义版本优先使用
- **Module Boundaries**: AgentRegistry（扫描优先级） → 无跨模块交互
- **AC 覆盖**: AC-1.3

## UC-3: 空环境正常降级

- **Actor**: 任何 workflow 脚本
- **Preconditions**: 系统中无任何 agent `.md` 文件
- **Main Flow**:
  1. `session_start` 触发 `discoverAll()` → cache 为空
  2. 旧的 `agent("prompt")` 调用正常工作
  3. `agent({ agent: "x", prompt: "..." })` 调用返回 `Agent not found` 错误
- **Postconditions**: 系统功能不受影响，status action 不含 agents 列表
- **Module Boundaries**: AgentRegistry（空缓存） → Orchestrator（错误处理）
- **AC 覆盖**: AC-5.1, AC-5.2, AC-5.3

## UC 覆盖映射

| UC | AC |
|----|----|
| UC-1 | AC-2.1, AC-2.2, AC-3.1 |
| UC-2 | AC-1.3 |
| UC-3 | AC-5.1, AC-5.2, AC-5.3 |
| (AC-1.1, 1.2) | TC-1-01, TC-1-02 直接覆盖，无 UC |
| (AC-1.4, 1.5, 1.6) | TC-1-04, TC-1-05, TC-1-06 直接覆盖 |
| (AC-2.3, 2.4, 2.5) | TC-2-02, TC-2-04, TC-2-05 直接覆盖 |
| (AC-3.2) | TC-3-01（并发 UUID 独立性） |
| (AC-4) | TS-4 集成测试覆盖 |
| (AC-6) | TC-6-01 手动验证 |
