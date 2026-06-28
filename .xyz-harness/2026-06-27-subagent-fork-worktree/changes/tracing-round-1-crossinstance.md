---
converged: true
phase: nfr
round: 1
scope: cross-instance (#3/#12/#13)
viewpoints: [副作用覆盖性, 缓解可行性]
---

# 正向追踪 Round 1 — 跨实例族 (#3/#12/#13)

> 2 视角。对照 decisions.md D-014/D-021/D-023/D-024/D-025/D-026 + system-architecture §5 + 源码 record-store.ts/session-runner.ts/session-file-gc.ts/tombstone-store.ts。

## 总结

7 个 K gap（无 F/D/阻断）。核心残留风险（pid 复用 → 接受概率正确非确定正确，D-021 已拍板）合法确认，不重报。建议收敛前处理 K-2（24h 僵尸监控盲区）+ K-4（crashed↔externalInstance 翻转）两条中等完整性 gap。

| Gap | Issue | 维度 | 严重性 | 阻断? |
|-----|-------|------|--------|------|
| K-1 | #3 | 安全 | 低 | 否 |
| K-2 | #12 | 残留风险+可观测 | 中 | 否（建议处理） |
| K-3 | #12 | 稳定性 | 低 | 否 |
| K-4 | #12 | 并发 | 中 | 否（建议处理） |
| K-label | #12 | 数据/AC 一致性 | 极低 | 否 |
| K-5 | #13 | 数据 | 低 | 否 |
| K-6 | #13 | 并发 | 低 | 否 |

## #3 SessionContextResolver — K-1 [K 低] 安全维度路径遍历风险面窄于实际输入面

NFR 安全维度风险是 mainSessionFile 路径遍历，缓解正确（SDK 受控）。但 SessionContextResolver 实际输入含 `cwd?: string`（#8 startParam 接受，用户控制）流向 effectiveCwd。对 effectiveCwd 危险路径构成无 AC/防护（AC-3.4 只 grep IO/SDK 副作用，非路径构成）。可利用性低（sessionDir 用 mainCwd 非 cwd，getSubagentSessionDir 编码）。

**建议**：安全维度补「effectiveCwd 仅作只读参数传 createAgentSession（非用于构建文件系统路径）」。

## #12 跨实例 crashed 协调 — 4 gap

### K-2 [K 中] 24h 僵尸监控盲区

残留风险表第 1 行描述 pid 复用为「跨实例误判 running-elsewhere（A 实际已死却显示 running）」——视为瞬时显示问题。实际失败模式：.alive 的 pid 被重分配给无关存活进程，isProcessAlive 返回 true → record 投影 externalInstance:true 长达 **24 小时**（直到软超时）。这是 24h **不可见崩溃（隐形僵尸 record）**非瞬时显示瑕疵。监控方式仅统计「24h 超时触发」，不含「pid 存活但非自身」情况 → 24h 僵尸窗口不可观测。

**建议**：记录最坏 24h 僵尸持续时间；增加指标（externalInstance record 年龄分布）让僵尸可观测。

### K-3 [K 低] 稳定性维度漏 AC-12.5 两个边缘

稳定性（⚠️）记 Windows process.kill 限制。但 AC-12.5 另枚举 `pid === process.pid`（不探活自己→false）和 `pid === 1`（文档标注已知限制）。AC 涵盖它们，NFR 完整性问题非运行时漏洞。

**建议**：稳定性维度补这两个边缘。

### K-4 [K 中] crashed↔externalInstance 翻转未分析

并发（⚠️）用「writeAliveMarker 单次写，读到=完整或读到无」解决 .alive 读/写竞态。单次写原子性处理部分写入，但未处理**缺失**写入：实例 B reconstructAll 在 A 的 writeAliveMarker 创建文件**之前**运行（合法窗口：session 存在，.alive 在 prompt 前写）→ B 无 .alive 也无 .finalized/.cancelled →「都无」分支 → **crashed**（误判），下次扫描（.alive 现存在）→ externalInstance。同一跨实例记录在扫描间分类**翻转 crashed→externalInstance**。

**建议**：并发维度补「B 在 A 写 .alive 前扫描 → crashed（保守安全），下次扫描 → externalInstance（最终收敛）；翻转可接受因 crashed 是安全降级」。

### K-label [K 极低] 四分支 vs 4 种组合 vs 5 组合 标签不一致

#12 数据维度说「四分支检测」=4 分支。AC-12.2 引用「4 种 sidecar 组合」但枚举**五种**（无标记/.cancelled/.finalized/.alive+活pid/.alive+死pid）。行为一致（两 crashed 子路径共享终态，仅 reason 不同），非 F。分支数（4）与测试矩阵数（5）标签不匹配。

## #13 alive-store — 2 gap

### K-5 [K 低] 数据维度漏 writeAliveMarker 自身抛错路径

数据（⚠️）事务边界枚举「进程死在写 .alive 之前 → 无 .alive → 正确 crashed」（正确）。但未枚举 writeAliveMarker **自身抛异常**（磁盘满/权限）路径，按设计静默吞噬（best-effort IO）。后果：子 agent 运行正常但 .alive 从未写入 → 所有跨实例观察者误判 crashed 整个运行期。

**建议**：数据/稳定性维度补 writeAliveMarker 抛错 → .alive 缺失 → 跨实例误判 crashed（best-effort 降级可接受，但须列出）。

### K-6 [K 低] 并发 ✅ "无竞争"与跨实例读侧竞争实际不符

并发标 ✅「无竞争（单 subagent 一个 .alive）」。单写入者真，但引入 .alive 的原因是**跨实例读取**（#12 reconstructAll/#4 reaper/#10 GC 均跨实例读）。✅「无竞争」框架误导——消费者面临读/(写|删)竞争（#12 K-4 / #10 GC vs 活跃运行 / #4 reaper vs 活跃运行）。

**建议**：✅ 弱化为「单写入者无写写竞争；跨实例读写竞争由消费者（#12/#10/#4）分析」。

## 关键核验结论（视角2）

- **#12 pid 复用兜底（startedAt+24h 软超时）可落地**（AC-12.3 常量提取+单测），"概率正确非确定"用户已接受（D-021）。但残留影响登记低估 24h 僵尸时长 + 监控盲区（K-2）。
- **#13 writeAliveMarker 与 prompt 之间窗口（进程死→正确 crashed）分析正确**（K-7 验证通过，非 gap）。
