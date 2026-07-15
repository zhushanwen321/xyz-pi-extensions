# Code Review — fix-robustness-high-batch

## 审查范围
- commits: b5225a320..3f73150f6（4 个 commit）
  - W1 (b5225a320): agent-result-mapper H4 修复
  - W2 (154cf8862): worker-script-builder H3 修复
  - W3 (e5f9fe6e3): subprocess-agent-runner + index.ts H1 修复
  - W4 (3f73150f6): concurrency-pool + subagent-service H2 修复

## 发现的问题

无 must-fix / should-fix。

### 逐 Wave 核对

#### W1: H4 — abort→completed 语义反转
- `agent-result-mapper.ts` L34: `r.error || "Agent call failed (aborted or unknown error)"` — 正确。abort 路径 (success=false, error=undefined) 现在 synthesize 非空 fallback，executeAgentCall 的 `error === undefined` 判定不再误判 completed。
- 测试覆盖：abort 路径 + 正常失败路径 + 成功路径三个分支。

#### W2: H3 — skill 字段丢失
- `worker-script-builder.ts` L173: 在 task/agent 分支的 opts 构造中加了 `skill: firstArg.skill`。与 prompt 分支（L164 整对象透传）对齐。
- 测试覆盖：源码断言验证 task/agent 分支含 skill 字段。

#### W3: H1 — SAR ctxModel stale
- `subprocess-agent-runner.ts`: ctxModel 从 `readonly` 改为可变 private，加 `updateCtxModel` 方法。设计合理——最小侵入，不改构造签名。
- `index.ts` model_select handler: 新增 `state.runner.updateCtxModel(event.model)`。正确刷新 SAR。
- 测试覆盖：updateCtxModel 后 run() 传入新值。

#### W4: H2 — ConcurrencyPool acquire 无 abort
- `concurrency-pool.ts`: acquire 加第三参数 AbortSignal。排队条目注册 abort listener，abort 时 reject + splice 出 queue。resolve 时 removeEventListener 清 listener。
- `subagent-service.ts`: acquire 传 signal，catch 路径返回 finalizeFailed（不持有槽位）。finally 用 `acquired` flag 守卫 release。
- 测试覆盖：abort reject + 正常 resolve 两个分支。
- 注意：subagent-service.ts 999 行（历史遗留技术债，压缩了注释保持在上限内）。

### 测试质量审查
- 4 个红灯测试各覆盖一个 bug 的核心场景（abort 路径/skill 丢失/ctxModel 刷新/排队 abort）
- 非异常路径回归测试（concurrency-pool 的 non-aborted resolve）作为防线
- E1 全量回归（960 tests）确保不破坏既有行为

## 结论
- must-fix: 0
- should-fix: 0
- nit: 0
