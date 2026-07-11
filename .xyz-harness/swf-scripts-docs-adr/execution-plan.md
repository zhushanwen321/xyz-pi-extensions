---
verdict: pass
upstream: code-architecture.md, non-functional-design.md, issues.md
---

# 执行计划 — T3 预制脚本 + 文档/ADR

> T3 是纯文档/脚本主题（refactor 模式），无新运行时代码。Wave 编排驱动因素是 issue 间的 blocked_by 依赖，
> 而非时序图（code-arch §4 已说明 T3 用追溯链替代运行时时序）。

## 依赖分析

```
#1 examples（4 脚本）     无依赖（workflow() 已在 T1 实现）
#2 ADR-030               无依赖
#3 ADR-026/029 superseded blocked_by #2
#4 skill-wf              blocked_by #1（脚本模式已定，示例对齐）
#5 skill-exe             blocked_by #3（ADR-029 superseded 后转移知识）
#6 AGENTS.md             无依赖（T1 已建新包）
#7 ext-deps              无依赖
#8 deprecated            blocked_by #7（依赖声明已更新）
```

## Wave 编排

| Wave | Issues | 并行组 | dependsOn | 说明 |
|------|--------|--------|-----------|------|
| W0 | #1, #2, #6, #7 | EX（脚本）/ DOC（文档/配置） | 无 | 4 个无依赖 issue 并行；W0 内按文件零冲突并行 |
| W1 | #3, #4 | DOC（ADR superseded）/ SKILL（skill-wf） | W0 | #3 blocked_by #2；#4 blocked_by #1 |
| W2 | #5, #8 | SKILL（skill-exe）/ DOC（deprecated） | W1 | #5 blocked_by #3；#8 blocked_by #7（W0）|

> **parallelGroup 说明**：EX/DOC/SKILL/E2E 是测试执行分组（同组可并行），Wave 级并行性由文件零冲突保证（非 parallelGroup 驱动）。

### Wave 内并行性

- **W0**：#1（examples/）与 #2（docs/adr/030）与 #6（AGENTS.md）与 #7（extension-deps）四路文件零冲突，全并行
- **W1**：#3（docs/adr/026/029）与 #4（skills/workflow-script-format）文件零冲突，并行
- **W2**：#5（skills/coding-execute）与 #8（旧包 package.json + CHANGELOG）文件零冲突，并行

## 测试验收清单

> 全量用例（来源 A），按 Wave 归属 + 测试层 + dependsOn/parallelGroup。
> 来源 B 无新增用例（nfr 12 条缓解项全部内化到来源 A）。

### W0 测试（#1 + #2 + #6 + #7）

| 用例 ID | 测试层 | 场景 | 关联 Issue# | dependsOn | parallelGroup |
|---------|--------|------|------------|-----------|--------------|
| T1.1 | unit | chain.example.js 含 meta + workflow() + phase | #1 | — | EX |
| T1.2 | integration | chain.example.js 通过 lintScript | #1 | T1.1 | EX |
| T1.3 | unit | chain 含 try-catch 返回 error | #1 | T1.1 | EX |
| T1.5 | unit | chain 含 require() 无 ESM import | #1 | T1.1 | EX |
| T1.6 | e2e | 用户复制 chain 到 .pi/workflows/ + workflow run | #1 | T1.2 | E2E |
| T1.7 | integration | package.json files 含 examples/ | #1 | T1.1 | EX |
| T2.1 | unit | parallel.example.js 含 parallel() + workflow() | #1 | — | EX |
| T2.2 | integration | parallel.example.js 通过 lintScript | #1 | T2.1 | EX |
| T2.3 | unit | parallel 用 allSettled 语义 | #1 | T2.1 | EX |
| T2.4 | unit | parallel 注释含分层配额规则 | #1 | T2.1 | EX |
| T2.5 | e2e | parallel 模板可被 workflow run 加载 | #1 | T2.2 | E2E |
| T3.1 | unit | scatter-gather 含 split→process→merge 三段 | #1 | — | EX |
| T3.2 | integration | scatter-gather 通过 lintScript | #1 | T3.1 | EX |
| T3.3 | unit | scatter-gather 含 parallel(process) + workflow(merge) | #1 | T3.1 | EX |
| T3.4 | unit | scatter-gather 含 try-catch | #1 | T3.1 | EX |
| T3.5 | e2e | scatter-gather 可被 workflow run 加载 | #1 | T3.2 | E2E |
| T4.1 | unit | map-reduce 含 parallel map → reduce 两段 | #1 | — | EX |
| T4.2 | integration | map-reduce 通过 lintScript | #1 | T4.1 | EX |
| T4.3 | unit | map-reduce 含 workflow("reduce") | #1 | T4.1 | EX |
| T4.4 | e2e | map-reduce 可被 workflow run 加载 | #1 | T4.2 | E2E |
| T5.1 | unit | ADR-030 含 Status/Context/Decision/Consequences 四节 | #2 | — | DOC |
| T5.2 | unit | Status = Accepted | #2 | T5.1 | DOC |
| T5.3 | unit | Decision 含 4 项核心决策关键词 | #2 | T5.1 | DOC |
| T5.4 | unit | 并发上限标注来源 T2 | #2 | T5.1 | DOC |
| T5.5 | unit | 引用 ADR-026/029 为前置 | #2 | T5.1 | DOC |
| T5.6 | unit | ADR-030 含 L3A 承接说明 | #2 | T5.1 | DOC |
| T7.1 | unit | AGENTS.md 目录树含 subagents-workflow | #6 | — | DOC |
| T7.2 | unit | 包清单表含新包行 | #6 | — | DOC |
| T7.3 | integration | check-structure 通过 | #6 | T7.1, T7.2 | DOC |
| T7.4 | unit | 关键约束段无「两个 spawn」旧描述 | #6 | T7.1 | DOC |
| T8.1 | unit | 含 subagents-workflow 条目 | #7 | — | DOC |
| T8.2 | unit | coding-workflow dependsOn 迁移到新包 | #7 | T8.1 | DOC |
| T8.3 | integration | ajv validate 通过 | #7 | T8.1 | DOC |
| T8.4 | unit | 旧两包条目标注 superseded | #7 | T8.1 | DOC |
| T8.5 | integration | AGENTS.md ↔ ext-deps 双向一致 | #7 | T7.2, T8.1 | DOC |

### W1 测试（#3 + #4）

| 用例 ID | 测试层 | 场景 | 关联 Issue# | dependsOn | parallelGroup |
|---------|--------|------|------------|-----------|--------------|
| T6.1 | unit | ADR-026 Status = Superseded by ADR-030 | #3 | T5.1 | DOC |
| T6.2 | unit | ADR-029 Status = Partially superseded | #3 | T5.1 | DOC |
| T6.3 | unit | ADR-029 说明段逐决策标注 | #3 | T6.2 | DOC |
| T6.4 | unit | ADR-026/029 正文保留不动（git diff） | #3 | T6.1 | DOC |
| T9.1 | unit | SKILL.md 含 workflow() 函数说明 | #4 | — | SKILL |
| T9.2 | unit | parallel() 上限改为 6 | #4 | — | SKILL |
| T9.3 | unit | 含 chain/parallel 基础示例 | #4 | T9.1 | SKILL |
| T9.4 | integration | skill frontmatter YAML 合法 | #4 | T9.1 | SKILL |

### W2 测试（#5 + #8）

| 用例 ID | 测试层 | 场景 | 关联 Issue# | dependsOn | parallelGroup |
|---------|--------|------|------------|-----------|--------------|
| T11.1 | unit | coding-execute SKILL.md 含 worktree 编排说明 | #5 | — | SKILL |
| T11.2 | unit | 内容来自 ADR-029 决策 2 | #5 | T11.1 | SKILL |
| T11.3 | integration | skill frontmatter YAML 合法 | #5 | T11.1 | SKILL |
| T10.1 | unit | 旧两包 package.json 含 deprecated 字段 | #8 | — | DOC |
| T10.2 | unit | deprecated 消息含迁移路径 | #8 | T10.1 | DOC |
| T10.3 | unit | CHANGELOG 含迁移说明 | #8 | T10.1 | DOC |

## 测试层统计

| 测试层 | 数量 | 占比 | 说明 |
|--------|------|------|------|
| unit | 35 | 71% | 结构/grep 校验（ADR 章节、json 字段、脚本内容、Status 行） |
| integration | 10 | 21% | lintScript、ajv、check-structure、validate-skill-yaml、npm pack、交叉校验 |
| e2e | 4 | 8% | 4 个模板复制到 .pi/workflows/ + workflow run 加载 |
| perf-chaos | 0 | 0% | T3 无性能测试 |
| **合计** | **49** | 100% | — |

## 垂直切片说明

T3 每个 Wave 是一个完整的「可验证交付物组」：
- **W0** 产出后即可独立验证 4 脚本 + ADR-030 + AGENTS.md + ext-deps（35 条测试）
- **W1** 产出后追加验证 ADR superseded + workflow-script-format skill（8 条测试）
- **W2** 产出后追加验证 coding-execute skill + 旧包 deprecated（6 条测试），完成全部 49 条

## P3 延后项

无。T3 是三主题收尾，所有交付物在本次 Wave 完成。
