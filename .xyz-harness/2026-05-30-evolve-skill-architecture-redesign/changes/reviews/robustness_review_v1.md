---
review:
  type: code_review
  round: 1
  timestamp: "2026-05-31T01:15:00"
  target: "evolve-daily/src/index.ts + skills/evolve/SKILL.md + skills/evolve-apply/SKILL.md + skills/evolve-report/SKILL.md"
  verdict: fail
  summary: "健壮性审查第1轮，4条MUST FIX，需修改后重审"

statistics:
  total_issues: 8
  must_fix: 4
  must_fix_resolved: 0
  low: 3
  info: 1

issues:
  - id: 1
    severity: MUST_FIX
    location: "evolve-daily/src/index.ts:L30-35"
    title: "analyzer 失败时未清理可能残留的不完整 JSON 文件"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 2
    severity: MUST_FIX
    location: "skills/evolve-apply/SKILL.md:APPLY Mode step 4"
    title: "edit 失败后 pending.json 状态正确，但 backup 文件残留未清理"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 3
    severity: MUST_FIX
    location: "skills/evolve-apply/SKILL.md:ROLLBACK Mode step 4"
    title: "rollback 后未更新 pending.json 中对应 suggestion 的状态"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 4
    severity: MUST_FIX
    location: "skills/evolve/SKILL.md:step 5"
    title: "write pending.json 失败时 suggestions 丢失，无错误处理指令"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 5
    severity: LOW
    location: "evolve-daily/src/index.ts:L23-25"
    title: "REPORTS_DIR 目录不存在时 analyzer 可能静默失败"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 6
    severity: LOW
    location: "skills/evolve-apply/SKILL.md:APPLY Mode step 5"
    title: "git commit 失败时 commitSha 为空，但 instruction 字段可能含引号破坏 JSON"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 7
    severity: LOW
    location: "skills/evolve-report/SKILL.md:step 1"
    title: "无 daily-reports 目录时无明确提示指令"
    status: open
    raised_in_round: 1
    resolved_in_round: null

  - id: 8
    severity: INFO
    location: "evolve-daily/src/index.ts:L30-35"
    title: "console.error 在 Pi 多 session 环境中可能被其他 session 的日志淹没"
    status: open
    raised_in_round: 1
    resolved_in_round: null
---

# 健壮性审查 v1

## 评审记录
- 评审时间：2026-05-31 01:15
- 评审类型：编码评审（健壮性专项）
- 评审对象：evolve-daily/src/index.ts (36行) + 3 个 SKILL.md prompt 指令文件

## 六维度审查

### 1. 错误处理

| 组件 | 失败点 | 处理状态 | 评估 |
|------|--------|---------|------|
| evolve-daily | python3 analyzer 执行失败 | ✅ try/catch + console.error | 基本覆盖，但有残留问题（见 #1） |
| evolve-daily | REPORTS_DIR 不存在 | ❌ 无 mkdir | 见 #5 |
| evolve SKILL | 无数据场景 | ✅ 明确指令 "No data" 提示 | OK |
| evolve SKILL | write pending.json 失败 | ❌ 无错误处理指令 | 见 #4 |
| evolve-apply | pending.json 不存在/损坏 | ⚠️ list 模式有提示，apply 模式未显式说明 | 部分 |
| evolve-apply | backup 失败 | ✅ ABORT | OK |
| evolve-apply | edit 失败 | ✅ ABORT + 保持 pending | OK 但有残留（见 #2） |
| evolve-apply | git commit 失败 | ✅ CONTINUE | OK |
| evolve-apply | rollback backup 不存在 | ✅ 有明确提示 | OK |
| evolve-report | 无报告文件 | ❌ 无明确指令 | 见 #7 |

### 2. 异常安全

**evolve-daily/src/index.ts：**
- ✅ `existsSync(reportPath)` 前置检查防止重复生成
- ❌ analyzer 失败时，`--output reportPath` 可能已创建不完整文件（#1）。下次 session_start 检测到文件存在就跳过，导致永久缺失当天报告

**evolve-apply APPLY 流程（关键路径）：**
```
backup → edit → commit → update pending.json → append history.jsonl
```
| 步骤 | 失败后状态 | 一致性 |
|------|-----------|--------|
| backup 失败 | ABORT，无副作用 | ✅ 安全 |
| edit 失败 | ABORT，pending 不变，**但 backup 残留** | ❌ 见 #2 |
| commit 失败 | CONTINUE，pending 更新为 applied | ⚠️ 无 commit sha 可追溯 |
| write pending.json 失败 | edit 已执行但 pending 状态未更新 | ⚠️ 文件已改但状态仍是 pending |
| append history.jsonl 失败 | 已 applied 但无历史记录 | ⚠️ 无法 rollback |

**rollback 流程（#3）：**
- SKILL.md 的 rollback 步骤 4-6 执行 `cp backup → target`、`git commit`、`append history.jsonl`
- **但没有任何步骤更新 pending.json 中该 suggestion 的状态回 "pending" 或新状态**
- 如果用户再次 `/evolve-apply list`，已 rollback 的 suggestion 仍显示 "applied"

### 3. 日志/可观测性

| 组件 | 评估 |
|------|------|
| evolve-daily | ✅ `console.error("[evolve-daily] analyzer failed:", e)` — 有前缀、有错误对象 |
| evolve SKILL | ❌ 纯 prompt 指令，无结构化日志要求。LLM 直接向用户展示结果，日志依赖 Pi 自身 |
| evolve-apply | ⚠️ 步骤 8 有确认消息，但中间步骤失败时的信息只有 "tell user reason"，无结构化格式要求 |
| evolve-report | ⚠️ 无错误日志要求 |

### 4. Fail-fast / 前置条件检查

| 组件 | 前置检查 | 评估 |
|------|---------|------|
| evolve-daily | `existsSync(reportPath)` 防重复 | ✅ OK |
| evolve-daily | `ANALYZER_PATH` 存在性 | ❌ 无检查，analyzer 不存在时 exec 直接抛错（被 catch 但原因不明确） |
| evolve-apply | index N 越界检查 | ✅ "validate index N exists" |
| evolve-apply | status == "pending" 检查 | ✅ "validate ... status is pending" |
| evolve-apply | pending.json 文件存在性 | ⚠️ 隐含在 "Read pending.json" 中，未显式说明解析失败怎么办 |

### 5. 测试友好

**evolve-daily/src/index.ts：**
- ❌ `ANALYZER_PATH` 和 `REPORTS_DIR` 硬编码为模块常量，无法注入测试替身
- ❌ 核心逻辑在 `session_start` 回调内，无法独立调用测试
- ❌ `pi.exec` 是外部依赖，无法 mock（除非 mock 整个 pi 对象）
- **评估：需要将路径构建和执行逻辑提取为可注入参数的函数，才能进行单元测试**

**SKILL.md 文件：**
- 作为 prompt 指令，测试方式是评估 LLM 执行的准确度，不适用传统单元测试
- evolve-apply 的流程步骤足够明确，可设计集成测试（准备 pending.json → 执行命令 → 验证文件状态）

### 6. 调试友好

| 场景 | 出错时可追溯信息 | 评估 |
|------|-----------------|------|
| analyzer 失败 | console.error 包含完整 error 对象 | ✅ |
| pending.json 损坏 | 无 JSON parse 错误处理指令 | ⚠️ |
| edit 失败原因 | "tell user reason" 但未要求保留 edit 工具的错误信息 | ⚠️ |
| rollback 找不到 backup | 有明确的 backupPath 提示 | ✅ |
| history.jsonl 损坏 | 无解析错误处理 | ⚠️ |

## 重点审查：evolve-apply 的 edit 失败路径

完整追踪 edit 失败时的状态传播：

```
步骤 3: backup 已创建 ✅
步骤 4: edit 失败 → ABORT
        - pending.json: 未修改，suggestion 保持 "pending" ✅
        - history.jsonl: 未追加 ✅
        - targetPath: 未修改 ✅
        - backup 文件: 已创建，残留 ❌ (#2)
```

**结论：pending.json 一致性正确。** edit 失败不会导致 pending.json 状态错乱。但 backup 文件残留是个问题——多次重试会积累无用 backup 文件。

**更大的风险在后续步骤：**
```
步骤 6: write pending.json 失败 → edit 已执行但状态未更新
        - targetPath 已被修改 ❌
        - pending.json 仍显示 "pending" ❌
        - 用户重试 apply 会再次执行 edit（可能导致重复修改）❌
```
这个场景未在 SKILL.md 中被覆盖（#4 的变体）。

## 发现的问题

| # | 优先级 | 文件/位置 | 描述 | 修改建议 |
|---|--------|----------|------|---------|
| 1 | MUST FIX | evolve-daily/src/index.ts:L30-35 | analyzer exec 失败时 `--output reportPath` 可能已创建空文件或不完整 JSON。下次 `existsSync` 返回 true 导致永久跳过当天报告 | 失败时 `unlinkSync(reportPath)` 删除残留文件（先 existsSync 再 unlink），或改用先写临时文件再 rename 的原子写入策略 |
| 2 | MUST FIX | evolve-apply/SKILL.md:APPLY step 4 | edit 失败后 ABORT，但步骤 3 创建的 backup 文件未清理指令。多次重试会积累无用 backup | 在 "If edit fails → ABORT" 后追加："Use `bash` to delete the backup file created in step 3" |
| 3 | MUST FIX | evolve-apply/SKILL.md:ROLLBACK step 4 | rollback 恢复文件后，未将 pending.json 中该 suggestion 的状态从 "applied" 改回 "pending"。后续 list 仍显示 applied | rollback 流程增加步骤：读取 pending.json，将对应 suggestion status 改为 "rolled_back"，write 回去 |
| 4 | MUST FIX | evolve/SKILL.md:step 5 | write pending.json 没有失败处理指令。如果 write 失败，suggestions 丢失且用户无感知 | 增加错误处理："If write fails, inform user with the error message and suggest retry. Display the generated suggestions as text fallback." |
| 5 | LOW | evolve-daily/src/index.ts:L23-25 | REPORTS_DIR 不存在时，python3 --output 写入该路径可能失败（取决于 python3 是否自动 mkdir） | 在 exec 前增加 `mkdirSync(REPORTS_DIR, { recursive: true })` |
| 6 | LOW | evolve-apply/SKILL.md:APPLY step 7 | history.jsonl 的 heredoc 中 `instruction` 字段可能包含单引号或特殊字符，破坏 JSON 格式 | 改用 python3 -c 写入 JSON 行，或使用 jq，确保正确转义 |
| 7 | LOW | evolve-report/SKILL.md:step 1 | `ls *.json 2>/dev/null` 无输出时，未明确指示如何告知用户 | 增加指令："If no .json files found, display: 'No reports available. Run /evolve to generate data.'" |
| 8 | INFO | evolve-daily/src/index.ts:L30-35 | console.error 在 Pi 多 session 环境中可能被淹没，建议加 `[evolve-daily]` 前缀已有，可考虑写文件日志 | 低优先级，当前 console.error + 前缀可接受 |

> 优先级定义：
> - **MUST FIX**：不修复则评审不通过，会阻塞流程
> - **LOW**：建议修复，但不阻塞
> - **INFO**：观察记录，无需操作

#### 等级判定理由

- **#1 MUST FIX**：analyzer 失败导致永久丢失当天报告，属于数据丢失类问题
- **#2 MUST FIX**：backup 残留不是孤立问题——rollback 流程可能误用残留 backup 恢复到错误状态
- **#3 MUST FIX**：rollback 后 pending.json 状态不一致，属于数据语义错误
- **#4 MUST FIX**：write 失败导致 suggestions 静默丢失，属于数据丢失

### 结论

需修改后重审

### Summary

健壮性审查完成，第1轮，4条MUST FIX，需修改后重审。核心问题集中在异常安全：analyzer 残留文件、backup 清理、rollback 状态一致性和 write 失败处理。
