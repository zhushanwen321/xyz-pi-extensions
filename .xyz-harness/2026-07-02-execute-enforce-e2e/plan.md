# 计划：execute 强制执行 mock 层测试（L3 机器门）

## 背景与问题

**起因**：coding-execute 执行时，AI 容易跳过 E2E 测试（含 mock 和非 mock 部分）。

**已做**（已提交 `03698ebf5`）：check_execute.py 机器门——校验 `test-results.json` 覆盖 plan 全部用例。

**剩余弱点**：AI 能伪造 `test-results.json`（因为 AI 控制文件写入）。攻击路径：
```
AI 不派 test-runner → 直接 write(test-results.json, [{id:"U1",status:"pass"}...])
→ 跑 check_execute.py → PASS（格式合规）→ goal_control(complete)
```

**本计划解决**：mock 层（单测 U* + mock E2E）的伪造。mock 层是 AI 最常跳、最没理由跳的层（快、无外部依赖）。让 check_execute 自己跑 mock 层测试、解析真实产物，AI 不参与数据生产。

**不解决**（已知天花板，需后续评估）：
- real 层伪造（环境复杂，仍靠 test-runner + user_confirm_ref）
- AI 压根不跑 check_execute（需 L4 pi-goal pre-complete hook，跨 repo）

## 范围守门

本改造属于 L1 小功能（无架构改动）：
- 改 1 个脚本（check_execute.py）+ 衔接文档（2-3 个 reference/SKILL）
- 不跨子系统、不改状态机、不需架构决策
- 走 lite-plan 级别的 plan 即可

## 关键源码事实（已核实）

| 事实 | 位置 | 对设计的影响 |
|------|------|------------|
| check_execute.py 已有 `check_coverage_gate` 解析 gate 命令 | `check_execute.py:check_coverage_gate` | gate 命令可复用，直接 subprocess 执行 |
| execSync 支持 cwd 参数 | Node.js 内置 | 可指定 test worktree 为执行目录 |
| 测试框架产物：vitest `coverage-summary.json` / jest `coverage-final.json` + `junit.xml` | 框架标准产物 | 可机器解析，AI 难伪造（行号精确映射源码） |
| check_execute 当前只读 status 字段，不读 evidence | `check_execute.py:load_results` | evidence 字段当前是死数据 |

## 为什么不做 workflow 化（Phase 2 不推荐）

源码核实出 workflow 的 `agent()` **不支持 per-call cwd**（`pi-runner.ts:91` spawn 无 cwd 选项，knownFields 无 cwd）。workflow 派的 subagent 全在 workflow 进程同一 cwd 跑——implementer 无法各自 worktree 隔离。要解决需先改 workflow extension（跨包改造），ROI 低。

本计划用 `execSync`（支持 cwd）规避此障碍，聚焦解决原始问题（防跳 E2E），不碰编排改造。

## 技术改动点

### 核心机制：mock 层从「校验 AI 声明」升级为「自己执行」

当前 check_execute 对 mock 层：读 test-results.json 的 status 字段 → 判定 pass/fail。
改后 check_execute 对 mock 层：**subprocess 跑 plan 的 gate 命令 → 解析框架真实产物 → 每条用例真实 status**。

```
改前：AI 跑测试 → AI 写 test-results.json → check_execute 读 json 判定
改后：check_execute 自己跑测试 → check_execute 解析真产物 → 判定（AI 不参与 mock 层数据生产）
```

real 层维持现状（test-runner subagent 跑 + test-results.json + user_confirm_ref）。

### 解析真实产物的策略

不同测试框架产物不同，按探测结果选解析器：

| 框架 | 产物文件 | 解析方式 |
|------|---------|---------|
| vitest | `coverage/coverage-summary.json` | 每文件行覆盖数 + `--reporter=json` 的测试结果 |
| jest | `coverage/coverage-final.json` + `junit.xml` | junit.xml 每 testcase 的 status |
| pytest | `.coverage` + `coverage.xml` | coverage.xml 的 line-rate + pytest exit code |

**关键**：gate 命令在 plan.md 已由 lite-plan 写好（覆盖率 gate 章节），check_execute 复用 `check_coverage_gate` 已解析的命令，不重新发明。

## Wave 拆分

### Wave 1：check_execute.py 增强 mock 层自跑（核心）

**改动文件**：`coding-execute/scripts/check_execute.py`

**具体改动**：
1. 新增 `run_mock_layer(plan_path, test_worktree, report)` 函数：
   - 从 plan.md 解析 gate 命令（复用 `check_coverage_gate` 的解析逻辑）
   - `subprocess.run(gate_cmd, cwd=test_worktree, capture_output=True, timeout=300)`
   - 解析框架产物（先探测框架：vitest? jest? pytest?）
   - 返回 `{case_id: real_status}` dict
2. 修改 `main()`：mock 层用例的判定改为「run_mock_layer 的真实结果覆盖 test-results.json 的声明」
3. real 层用例：维持读 test-results.json（status pass 或 user-skipped+ref）
4. test-results.json 的 mock 层条目：改为「check_execute 生成」而非「AI 声明」

**test_worktree 来源**：
- 新增 `--test-worktree` 参数（coding-execute 调用时传入）
- 缺失时降级为「读 test-results.json」（向后兼容，但记 WARN）

### Wave 2：selftest 覆盖新逻辑

**改动文件**：`coding-execute/scripts/selftest_check_execute.py`

新增测试用例：
- `mock_self_run_pass`：mock 层真跑全绿 → exit 0
- `mock_self_run_fail`：mock 层真跑有 fail → exit 1（即使 json 声明 pass）
- `mock_json_overridden`：json 声明 pass 但真跑 fail → 以真跑为准 exit 1（核心防伪）
- `real_still_reads_json`：real 层仍读 json（user-skipped+ref → exit 0）
- `no_worktree_fallback`：无 --test-worktree → 降级读 json + WARN

### Wave 3：衔接文档更新

**改动文件**：
- `lite-shared/references/execution-flow.md`：阶段 C gate 说明改为「mock 层 check_execute 自跑，real 层读 test-runner 报告」
- `lite-shared/references/subagent-dispatch.md`：test-runner task 调整为「只跑 real 层 + 产出 real 层 test-results.json」
- `coding-execute/SKILL.md`：[铁律] 补充「mock 层由 check_execute 自跑，test-runner 只负责 real 层」

## 测试验收

### 单测用例

| ID | 覆盖点 | 输入 | 预期 | 类型 |
|----|--------|------|------|------|
| U1 | run_mock_layer | plan 含 vitest gate + 真测试全绿 + test_worktree | 返回 {U1:pass,...} | 正常 |
| U2 | run_mock_layer | plan gate 命令跑失败（exit≠0） | 返回失败用例集 | 异常 |
| U3 | run_mock_layer | gate 命令 timeout（>300s） | 记 FAIL + 报告超时 | 边界 |
| U4 | main mock 判定 | json 声明 pass 但真跑 fail | exit 1（防伪核心） | 正常 |
| U5 | main real 判定 | real 层 user-skipped+ref | exit 0（real 不自跑） | 正常 |
| U6 | 框架探测 | 无 coverage-summary.json 但有 junit.xml | 用 junit 解析 | 边界 |

### E2E 用例

| ID | 场景 | 测试层 | 步骤 | 预期 | 执行方式 |
|----|------|--------|------|------|---------|
| E1 | 真实 plan 跑通 | mock | 用本仓库的一个真 plan.md + 真测试 | check_execute exit 0 | python3 check_execute.py plan.md --test-worktree . |
| E2 | 伪造 json 被抓 | mock | 手写假 json（全 pass）但不跑测试 | exit 1 | python3 check_execute.py plan.md |

### 覆盖率 gate

- 命令：`python3 -m pytest coding-execute/scripts/ --cov=check_execute`
- 阈值：新增逻辑（run_mock_layer）行覆盖 ≥ 70%

## 风险与回退

| 风险 | 应对 |
|------|------|
| gate 命令在错 cwd 跑（multi-workspace） | `--test-worktree` 强制传入；缺失记 WARN 不静默错跑 |
| 框架探测失败（非 vitest/jest/pytest） | 降级为「exit code 判定」（gate 命令 exit 0 = mock 层全过），记 WARN |
| subprocess timeout 卡死 | timeout=300s + 超时记 FAIL |
| 向后兼容（旧调用不传 --test-worktree） | 降级读 json + WARN，不 break 现有流程 |

**回退**：Wave 1 改动集中在 check_execute.py 的 mock 层判定分支，real 层不动。出问题 revert check_execute.py 即可，check_execute 退回读 json 模式。

## 不做（YAGNI）

- real 层自跑（环境复杂，靠 test-runner + user_confirm_ref）
- 编排 workflow 化（cwd 硬障碍，ROI 低）
- L4 pi-goal pre-complete hook（跨 repo，单独评估）
- evidence 字段校验（死数据复活，边际收益低，先靠产物校验）
