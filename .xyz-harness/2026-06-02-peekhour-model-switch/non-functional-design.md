---
verdict: pass
---

# Non-Functional Design — peekhour-model-switch

## 1. 稳定性

改动是纯删除+替换模式：删除推荐引擎的 4 个函数（computeRecommendation/detectScene/budgetDecision/computeQuotaSnapshotFromCache），替换为 3 个纯数据提取函数。新的 `computeQuotaSnapshot` 和 `computeStickiness` 都是**无副作用的纯函数**，输入 cache/entries，输出结构化数据。相比旧代码，减少了状态依赖和分支逻辑，降低了运行时错误概率。唯一的 fallback 路径是 cache 为空 → quota 行跳过，这是设计意图而非缺陷。

## 2. 数据一致性

不涉及数据存储。`model-policy.json` 是用户手动管理的只读配置。`statusline_cache.json` 由 statusline 扩展写入，model-switch 只读取。两个文件通过文件系统松耦合，无并发写入冲突。新增的 PlanConfig 字段（peakStrategy/rollingWindowHours/thresholds）通过 `loadConfig` 的默认值填充保证一致性——旧配置文件不会有这些字段，但加载后的内存对象总是完整的。

## 3. 性能

`before_agent_start` 每个 turn 执行一次。耗时操作：`readCache()` 读取本地 JSON 文件（<1KB），`getBranch()` 遍历 session entries（通常 <100 条），`formatContextPrompt()` 字符串拼接。总计 <5ms，不构成性能瓶颈。注入文本 ≤200 tokens（约 300 bytes），对上下文窗口的影响可忽略（Claude 200k context 中的 0.1%）。

## 4. 业务安全

不适用。model-switch 是开发者工具扩展，不处理用户隐私数据、支付信息或安全敏感操作。注入文本中的用量百分比和模型名称不构成敏感信息泄露。

## 5. 数据安全

不适用。model-switch 不修改任何外部文件（除了 setup 命令生成 model-policy.json，这是用户明确触发的操作）。`readCache()` 读取的 quota 数据存储在本地 `~/.pi/` 目录，不涉及网络传输或远程存储。
