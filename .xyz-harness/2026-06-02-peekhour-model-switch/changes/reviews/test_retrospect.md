---
phase: test
verdict: pass
absorbed: false
topic: "2026-06-02-peekhour-model-switch"
harness_issues:
  - "gate 脚本查找 taste_review_v*.md 但实际文件名为 ts_taste_review_v*.md，需要手动创建副本。应改为 glob 匹配 *taste*review*"
  - "gate 检查 prior phases 的 review 文件时，不识别 ts_taste_review 前缀变体。命名约定未在 skill 文档中明确指定"
---

# Phase 4 Retrospect: Test

## 1. Phase Execution Review

### Summary

12 个测试用例全部在 round 1 通过。测试方式：由于 Pi extension 运行时依赖（`@mariozechner/pi-coding-agent` SDK、`readCache()` 文件 IO、`ctx.sessionManager`）无法在独立单元测试中模拟，采用 Node.js 直接 import 纯函数 + 构造模拟数据的方式执行。

核心验证点：
- **数据链路**（TC-2-01/02）：cache → snapshot → prompt，6 个数值全部匹配真实 cache 数据
- **降级路径**（TC-2-03）：空 cache → null snapshot → quota 行跳过
- **粘性逻辑**（TC-3-01/02）：compaction 检测和 warm/cold 判断
- **时间判断**（TC-4-01/02）：高峰期标记和三条件规则
- **向后兼容**（TC-5-01）：旧配置不崩溃
- **代码清理**（TC-6-01）：推荐引擎函数全部删除
- **setup 生成**（TC-7-01）：新字段默认值正确

### Problems Encountered

1. **gate 脚本不识别 ts_taste_review 文件名**：Phase 3 的品味审查文件命名为 `ts_taste_review_v1.md`，但 gate 脚本查找 `taste_review_v*.md` 模式。Phase 4 gate 首次 FAIL，报 "no taste_review_v*.md found"。解决方案：创建同名副本 `taste_review_v1.md`/`taste_review_v2.md`。

2. **gate 检查未跟踪文件**：首次运行 `check_gate.py` 时 `test_execution.json` 未 git add，报 untracked files 错误。需要先 `git add -A` 再运行自检。

### What Went Well

- **12/12 一次通过**：所有纯函数设计使测试可以直接 import 验证，无需 mock Pi SDK
- **真实 cache 数据验证**：直接读取 `~/.pi/statusline_cache.json` 构造测试数据，验证了与生产数据格式的一致性
- **完整的注入文本预览**：测试脚本输出了 off-peak 和 peak 两种完整注入文本，可直接目视验证格式

### What Would I Do Differently

- **命名一致性**：review 文件应统一命名约定。`ts_taste_review` vs `taste_review` 的不一致在 Phase 3 就应该被发现并修正，而不是拖到 Phase 4 gate 失败后才发现
- **git add 在自检前**：`check_gate.py` 会检查 untracked files，应该养成先 `git add -A` 再跑自检的习惯

### Key Risks for Later Phases

- **无 Pi 运行时集成测试**：所有测试都是离线纯函数验证。`before_agent_start` 事件注册、`pi.setModel()` 调用、`ctx.sessionManager.getBranch()` 数据流只在 Pi 运行时验证。Phase 5 部署后需要实际运行验证
- **token 估算是粗略的**：TC-1-02 用 chars/3.5 估算 token 数（136/149），不是精确的 BPE 计数。实际 token 数可能有 ±10% 偏差，但远在 200 上限之下

## 2. Harness Usability Review

### Flow Friction

- **文件名匹配是最大摩擦**：gate 脚本硬编码了 `taste_review_v*.md` 模式，但 Phase 3 dispatch 的 subagent 输出为 `ts_taste_review_v*.md`。这个命名差异导致 Phase 4 gate 首次 FAIL，需要额外一轮修复（创建副本）+ 提交 + 重试。根本原因：review 文件命名约定未在 harness skill 文档中明确指定

### Gate Quality

- **test_execution.json 格式检查严格且正确**：验证了 caseId 覆盖、round 唯一性、passed 布尔类型、execute_steps 非空
- **untracked files 检查有价值**：防止遗漏提交，但应该在 skill 文档中提示"先 git add 再自检"
- **prior phase review 检查是合理的**：确保上游 phase 的审查已完成，但命名匹配逻辑需要更灵活

### Prompt Clarity

- Phase test skill 结构清晰：加载模板 → 执行 → 记录 → 修复 → 自检 → gate
- test_execution.json schema 文档详尽，常见错误列举有实际参考价值
- "FR→TC 覆盖矩阵"和"验证方式标注"的自检清单对于简单项目可能过度，但作为 completeness check 有存在价值

### Automation Gaps

- **纯函数测试可以自动化**：本次所有 12 个 TC 都是通过 Node.js import + 数据断言执行的。可以提取为 `npx vitest run` 测试套件，在 pre-commit hook 中自动运行。但这需要解决 Pi SDK 类型桩问题（`@mariozechner/*` 在 test 环境不可用）
- **gate 文件名匹配应改为 glob**：`*taste*review*` 比 `taste_review_v*` 更灵活，能匹配 `ts_taste_review` 等变体

### Time Sinks

- **文件名修复循环**（gate FAIL → 创建副本 → 提交 → 重试）占用了 1 轮不必要的交互
- **12 个 TC 的手动构造**：模拟数据（cache/config/entries）的构造约占测试编写时间的 60%。如果有共享的 test fixture 文件，可以减少重复
