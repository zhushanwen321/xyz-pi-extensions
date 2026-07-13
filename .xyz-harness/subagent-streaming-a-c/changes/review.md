# Code Review — subagent-streaming-a-c

## 审查范围
- commits: cde92de1a..05702b1fd（4 个 commit）
  - 26dbc538e test(W2): add SubagentStream lifecycle tests
  - eb374e079 refactor(W1+W3): promote PoC to production + document dual-channel design
  - 05702b1fd fix(review): guard empty delta + add test cases

## 发现的问题

| 维度 | 问题 | 严重度 | 位置 | 状态 |
|------|------|--------|------|------|
| 业务逻辑 | 空 delta 消耗 leading edge，延迟首帧 100ms | should_fix | stream-sink.ts:55 | **已修复** (05702b1fd) |
| 测试覆盖 | 缺空 delta 边界测试 | should_fix | stream-sink.test.ts | **已修复** (05702b1fd，+2 cases) |
| 代码规范 | import 逗号缺空格 | nit | stream-sink.test.ts:15,17 | **已修复** (05702b1fd) |
| 测试覆盖 | 缺 trailing 多窗口循环测试 | nit | stream-sink.test.ts | 接受（低风险，timer 重置逻辑已被 U2 间接覆盖） |

## 5 维度审查结论

### 1. 业务逻辑正确性 — 正确
- leading/trailing edge 合并状态机正确
- dispose 幂等（disposed 标志首行守护）
- text_delta 分流顺序正确（stream 在 onEvent 之前）
- 双通道互斥：background 走 stream（onEvent=undefined），workflow 走 onEvent（stream=undefined）
- streamSink null 降级正确

### 2. 类型安全 — 无问题
- 0 个 any，0 个 as 断言
- StreamSink 接口强类型使用
- mock sink 扩展接口而非绕过

### 3. 边界条件 — 正确
- 空 buffer flush 正确跳过（flush() 首行 timer 重置 + buffer 空检查）
- dispose 后 onDelta 静默（disposed 守护）
- 多行 split("\n") 正确

### 4. 测试覆盖 — 良好（10/10 通过）
- U1-U7 + dispose 3 子例 + 空 delta 2 例 = 10 cases
- 覆盖 happy path + 边界 + 异常分支

### 5. 代码规范 — 优秀
- [PoC] 残留：0
- [hypothetical seam] 标注：已移除（PoC 验证通过，确认单一 adapter）
- 注释解释"为什么"（双通道设计根因、streamSink null 降级原因）

## plan 覆盖核对
- [x] W1 changes[0]: stream-sink.ts [PoC] 清理 + [hypothetical seam] 移除 — 已落地
- [x] W1 changes[1]: session-runner.ts [PoC] 清理 — 已落地
- [x] W1 changes[2]: subagent-service.ts 6 处 [PoC] 清理 — 已落地
- [x] W1 changes[3]: index.ts [PoC] 清理 — 已落地
- [x] W2 changes[0]: stream-sink.test.ts 生命周期测试 — 已落地（10 cases，超 plan 的 6 cases）
- [x] W2 changes[1]: vi.useFakeTimers 控制时序 — 已落地
- [x] W3 changes[0]: executeAndAwait 双通道注释 — 已落地
- [x] W3 changes[1]: agentEvent 双通道注释 — 已落地

## 结论
- must_fix: 0
- should_fix: 2（均已修复）
- nit: 2（1 已修复，1 接受）

改动可合入。进入 test 阶段。
