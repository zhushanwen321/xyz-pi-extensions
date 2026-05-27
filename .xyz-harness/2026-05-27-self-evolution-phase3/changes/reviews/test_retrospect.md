---
phase: test
verdict: pass
---

# Test Phase Retrospect — self-evolution-phase3

## 1. Phase Execution Review

### Summary

执行了 12 个 test case，其中 8 个通过自动化测试验证（18 个断言），4 个通过 code_review 验证。测试过程中发现并修复了 2 个 bug：
1. `parseJudgeOutput` 的 REQUIRED_KEYS 包含 `"id"`——LLM Judge 输出不含此字段
2. `parseJudgeOutput` 拒绝 `"skills"`（复数）target——LLM 可能输出复数形式

### Problems Encountered

**P1: 测试脚本的模块解析问题**

初始用 `.ts` 后缀写测试文件，`npx tsx` 报 "Top-level await not supported with CJS output format"。改用 `.mts` 后缀解决（强制 ESM）。但 `.mts` 的动态 `import()` 路径解析又出问题——相对路径 `./state.ts` 被解析为 `evolution-engine/evolution-engine/src/state.ts`（路径重复），必须用绝对路径。

根因：tsx 的 ESM 路径解析与文件实际位置不一致。测试文件在 `tests/` 目录下，`import()` 的相对路径基于 CWD 而非文件位置。

教训：对于无独立构建步骤的 TS 项目，测试文件应该用绝对路径或基于 `import.meta.url` 构建路径，不要依赖 CWD。

**P2: parseJudgeOutput 的 3 个测试同时失败**

3 个 parseJudgeOutput 测试全部返回 0 条 suggestion，原因有两层：
1. REQUIRED_KEYS 包含 `"id"`——LLM 不会自动生成这个字段，测试数据也没提供
2. target 枚举只接受 `"skill"`（单数），测试数据用的是 `"skills"`（复数）

第一层是 plan/spec 没有明确 LLM 输出是否包含 `id` 字段。第二层是 types.ts 定义 `EvolutionSuggestion.target` 为 `"skill"`（单数），但 `EvolveCommandParams.target` 为 `"skills"`（复数），两个类型的 target 字段命名不一致。

教训：当 spec 定义了两个不同粒度的 target（命令级别 `"all"|"claude-md"|"skills"` vs 建议级别 `"claude-md"|"skill"`），应该在 types.ts 中用不同的类型名明确区分，parser 中做显式映射而非隐式容错。

**P3: 自动化测试覆盖有限**

12 个 TC 中只有 8 个能自动化。剩余 4 个（TC-1-01, TC-2-01, TC-3-01, TC-4-01）依赖 Pi 运行时（registerTool、registerCommand、TUI 渲染），无法在独立 Node 进程中测试。只能用 code_review 替代。

这意味着核心业务流程（/evolve 全流程、apply/rollback、stats）从未被实际执行过。真正的端到端验证要等用户安装后手动测试。

教训：Pi Extension 的可测试性受限于运行时依赖。如果核心逻辑（commands.ts 中的 handler）能通过依赖注入接收 Pi API 对象，就可以在测试中 mock 掉运行时依赖。

### What Would You Do Differently

1. **先写自动化测试再跑 code_review TC**：先用 tsx 写纯逻辑测试（state, judge, applier, monitor），确认通过后再对 Pi 运行时依赖的 TC 做 code_review。避免中间发现 bug 后要回头修复。
2. **测试文件直接用 `.mts` + 绝对路径**：跳过 CJS/EJS 格式问题的排查。
3. **在 Phase 3 dev 中就写部分测试**：TDD 流程要求先写测试再写实现。这次是先完成所有实现再统一写测试，发现 parseJudgeOutput 的 bug 更晚。如果在 dev 阶段就写 parseJudgeOutput 的单元测试，这两个 bug 会在 Phase 3 就被发现。

### Key Risks for Later Phases

1. **Pi 运行时集成未验证**：4 个 command handler 从未在真实 Pi 环境中执行。install 后可能有意想不到的问题（registerTool 参数格式、TUI 渲染、事件监听）。
2. **analyze.py 集成未验证**：execFileSync 调用 analyze.py 的参数格式（`--format json --output`）是否正确未经验证。
3. **LLM Judge 实际输出未验证**：parseJudgeOutput 的容错逻辑（markdown fence、id 自动生成、target 复数）基于假设。真实 LLM 输出可能有更多边缘情况。

## 2. Harness Usability Review

### Flow Friction

**code_review 替代的 TC 质量保证有限**：code_review 只是人工阅读代码确认逻辑存在，不等于运行时行为正确。对于 TC-1-01（/evolve 全流程）这种核心路径，code_review 的信心远低于自动化测试。

但当前 Pi Extension 架构下无法避免——handler 直接依赖 Pi API（`pi.registerTool`、`Text` 组件），无法在测试环境中实例化。

**test_execution.json 手动构造繁琐**：12 个 TC 的执行结果需要手写 JSON，包括 execute_steps 描述。对于 code_review 类 TC，steps 内容需要精确描述审查了哪些代码路径。如果能从测试脚本输出自动生成 JSON，效率会高很多。

### Gate Quality

Gate 一次通过，无回退。`test_execution.json` 格式验证和 TC ID cross-reference 都正确。

一个注意点：gate 只检查最终 round 的 `passed` 值。这次所有 TC 都是 round 1 通过，如果有 round 2 的修复记录，gate 会正确取 max(round) 那条。

### Prompt Clarity

phase-test skill 的指引清晰：
- test_execution.json 的字段 schema 和示例很详细，避免了格式错误
- code_review 替代的说明明确（"API tests: curl/httpx" → 对不上的用 code_review）
- Self-Check checklist 中的 FR→TC 覆盖矩阵检查提醒到位

一个不明确点：skill 说"代码审查替代的测试是否被如实标注为 `code_review`？"但 test_cases_template.json 中的 TC 都没有 `verification_method` 字段。这个检查项对当前 TC template 不适用（template 是在 Phase 2 产出的，那时候还没有这个要求）。

### Automation Gaps

1. **Pi Extension mock 框架**：缺少一个轻量的 Pi Extension 测试框架，能 mock `registerTool`/`registerCommand` 让 handler 可独立测试。
2. **test_execution.json 自动生成**：自动化测试的 results 应该能自动注入到 test_execution.json，减少手写工作量。
3. **tsc + test 联合 CI**：每次代码变更后自动运行 tsc + 集成测试，而不是手动执行。

### Time Spent

- 编写测试脚本：~10 分钟
- 排查 tsx 模块解析问题：~5 分钟
- 排查 parseJudgeOutput bug（id + skills）：~10 分钟
- 构造 test_execution.json：~10 分钟
- 更新 test_results.md：~5 分钟

总计约 40 分钟，其中 ~15 分钟花在环境问题上（tsx 格式、路径解析），~10 分钟在实际 bug 修复。测试本身效率尚可。
