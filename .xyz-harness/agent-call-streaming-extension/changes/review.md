# Code Review — agent-call-streaming-extension

## 审查范围
- commits: `0c034ce06` (W1) + `ff7d3af2f` (W2)
- 文件：ports.ts / execute-agent-call.ts / subprocess-agent-runner.ts / subagent-service.ts / error-recovery.ts / index.ts + 3 测试文件

## plan 覆盖核对

### W1 changes
- [x] `ports.ts: AgentRunner.run 签名加第 4 参 stream?: SubagentStream` — ports.ts:36 已加
- [x] `execute-agent-call.ts: executeAgentCall 签名加第 7 参 stream` — :120-128 已加
- [x] `execute-agent-call.ts: runner.run 调用处透传 stream` — :131 已改
- [x] `execute-agent-call.ts: retry 递归调用(:167)也透传 stream` — :168 已改
- [x] `subprocess-agent-runner.ts: SAR.run 签名加第 4 参 stream` — :75-79 已加
- [x] `subprocess-agent-runner.ts: 透传给 executeAndAwait 第 4 参` — :97 已改
- [x] `subagent-service.ts: executeAndAwait 签名加第 4 参 stream` — :442-446 已加
- [x] `subagent-service.ts: 透传给 runAndFinalize 第 8 参` — :482 已改

### W2 changes
- [x] `ports.ts: LifecycleDeps 加可选字段 streamSink?: StreamSink` — :167-176 已加
- [x] `error-recovery.ts: dispatchAgentCall 内创建 SubagentStream` — :299-302 已加
- [x] `error-recovery.ts: withSlot finally 调 stream?.dispose()` — :306-312 已加
- [x] `error-recovery.ts: executeAgentCall 调用透传 stream` — :310 已改
- [x] `index.ts: makeDeps 注入 streamSink=service.getStreamSink()` — :181 已加
- [x] `subagent-service.ts: 暴露 getStreamSink() public getter` — :176 已加

**覆盖结论**：plan 列出的全部 changes 均已落地，无遗漏。

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 |
|------|------|--------|------|
| 测试覆盖 | E1（real 层，executeAndAwait 路径 stream 到达 session-runner）尚未写测试代码 | should_fix | plan testCase E1 |
| 代码规范 | subagent-service.ts 999 行接近 1000 上限，getStreamSink 压缩为单行 | nit | subagent-service.ts:176 |
| 代码规范 | 测试中 `as never` / `as unknown as T` 断言（mock 构造）| nit | 测试文件多处 |

**must_fix = 0**。E1 是 real 层测试，需要 mock spawn 层构造完整 executeAndAwait 链路。当前 U1-U6 已覆盖核心逻辑（透传 + 创建 + dispose + widgetKey + 降级），E1 在 test 阶段补或标 skipped。

## 5 维度审查

1. **业务逻辑正确性**：stream 在 dispatchAgentCall 创建（runId-callId 组装 recordId），经 executeAgentCall → SAR.run → executeAndAwait → runAndFinalize → runSpawn 透传到 session-runner 的 opts.stream。dispose 在 withSlot finally（所有 retry 完成后）。streamSink 缺失时 stream=undefined，不 streaming 但不报错。逻辑对齐文档设计。

2. **类型安全**：stream 参数全程 `SubagentStream | undefined`，类型从 stream-sink.ts import。LifecycleDeps.streamSink 用 `StreamSink` 类型。无 any 滥用。

3. **边界条件**：streamSink=null/undefined → 不创建 stream（降级）；retry 递归复用同一 stream（不 dispose 不重建）；parallel 并发时各 agent call 独立 stream（widgetKey 含 stepIndex 区分）。

4. **测试覆盖**：U1（SAR 透传）、U2（executeAgentCall 透传）、U3（retry 透传）、U4（dispose）、U5（widgetKey 格式）、U6（降级）。E1（real 集成）待补。

5. **代码规范**：import 顺序经 eslint --fix 修正。与现有 onEvent 透传模式一致。

## 结论
- must_fix = 0，可进入 test 阶段
- E1 real 层测试在 test 阶段处理
