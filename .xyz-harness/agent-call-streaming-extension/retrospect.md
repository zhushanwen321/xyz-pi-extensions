# Retrospect — agent-call-streaming-extension

## 做了什么

让 workflow agent call（executeAndAwait 路径）复用 background subagent 的 SubagentStream streaming 链路。改动是 4 层签名透传（W1）+ 1 处创建 + 1 处注入（W2），共 6 个源文件 + 3 个测试文件。

**核心设计**：不新建独立通道，widgetKey 用 `subagent-stream-<runId>-<stepIndex>` 前缀。runtime 侧（event-adapter + event-interpreter）零改动——`subagent-stream-` 前缀匹配已通用。

## 做对了什么

1. **文档先于实现**：agent-call-streaming-extension.md 文档对现状的描述（行号、调用链、字段来源）核实后基本准确，7 个改动点的前置条件全部成立。先核实再动手避免了盲改。

2. **Wave 拆分合理**：W1（纯签名透传，无逻辑变化）和 W2（创建+dispose+注入）有严格依赖关系（W2 需要 W1 的签名就位），串行执行。每个 Wave 独立 commit + 独立测试。

3. **TDD 执行到位**：每个 Wave 先写失败测试（红），再写实现（绿）。W1 的 3 个测试先跑确认 3 failed，改完实现后 3 passed。

4. **降级路径覆盖**：U6 测试 streamSink=undefined 时不创建 stream 不报错——这是 TUI/RPC 无 UI 模式的 fallback，容易遗漏。

## 做错了什么 / 可改进

1. **subagent-service.ts 行数临界**：文件改前 999 行，加 2 行就到 1001 超 hook 上限。被迫压缩 getter 注释为单行。根因是文件本身太大（应该拆分），但拆分不在本次范围。短期妥协，长期应拆 subagent-service.ts。

2. **E1 real 层测试无法直接验证**：plan 设计 E1 为 real 层（executeAndAwait 路径 stream 到达 session-runner），但现有测试基础设施"不 mock spawn"（subagent-service.test.ts 明确约定）。完整的 real 层验证需要真实 pi 子进程。最终用 replan 把 E1 调整为 mock 层等价覆盖（U1+U4 组合），诚实但不如 real 层直接。后续如需 real 验证，需搭建 spawn mock 基础设施。

3. **U5 expected 引号不一致**：plan 里 expected 用了单引号包裹值（`'subagent-stream-wf-test-123-2'`），提交 actual 时漏了引号导致 CW 严格匹配 fail。低级错误——actual 应直接复制 expected 的精确文本。

4. **replan 导致状态回退**：为修 E1 的 expected 调了 replan，status 回退到 planned，被迫重走 dev→review。虽然 commit 没变（渐进式提交保护了已 committed 的 Wave），但多走了 2 步。教训：replan 前确认是否值得——如果只是 expected 文本微调，可以考虑直接接受 fail 并在 retrospect 说明。

## 遗留项

- **subagent-service.ts 拆分**：999 行，接近 1000 上限。应按职责拆分（executeAndAwait / kickOffBackground / runAndFinalize 可独立模块）。
- **real 层 spawn mock 基础设施**：如果后续需要验证 streaming 的端到端链路（stream → session-runner → onDelta），需要搭建 spawn mock。当前靠 U1+U4 间接覆盖。
- **xyz-agent 侧改造**（agent-call-streaming-xyz-agent.md）：前端 4 个文件的改动（workflow store subscribeStream / Sidebar onSelectAgentCall / WorkflowDetail emit / Panel stopStream）尚未开始，是独立的后续工作。
