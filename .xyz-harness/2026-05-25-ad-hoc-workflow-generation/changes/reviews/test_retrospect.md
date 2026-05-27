---
phase: test
verdict: pass
---

# Phase 4 (Test) 复盘 — Ad-hoc Workflow Generation

## Phase 执行质量

### 总结

17 个 test case 全部执行，最终 round 全部通过。首次提交被 gate 拒绝（零失败伪造信号），修复后通过。

### 遇到的问题

1. **TC-2-03 测试步骤设计缺陷**：test_cases_template.json 中 TC-2-03 用 `"invalid {{{"` 测试语法错误，但这个字符串没有 meta 导出，会先被 meta 检查拦截，根本到不了语法检查。真正的发现：测试用例设计时没有考虑验证逻辑的先后顺序（meta check → syntax check）。修复后用含 meta 但有语法错误的脚本重新验证。

2. **首次 gate FAIL — 零失败伪造信号**：17/17 case 全部 round=1 passed=true。gate review 正确指出这不符合真实测试执行特征。根因是 8 个 code_trace 类型的 case 没有实际运行验证，只做了代码阅读就标记通过。真实发现的 TC-2-03 逻辑问题和 MF2（dedup 过滤 unavailable）都被"读一遍代码就觉得没问题"跳过了。

3. **code_trace vs 自动化的边界模糊**：TC-1-01~TC-1-03（集成）、TC-3-04（并发）、TC-4-01~TC-4-05（面板）都是 code_trace 验证。这些 case 依赖 Pi 进程交互，确实无法在 Pi 外部自动化，但 code_trace 的质量参差不齐——有些只是"代码里有这个逻辑所以通过"，缺乏实际执行证据。

### 下次的不同做法

- **code_trace case 也要找真实问题**：不能只是"代码存在这个路径"就标通过。要主动寻找逻辑漏洞（比如 TC-2-03 的 meta check 优先级问题），把发现记录为 round 1 failure。
- **先跑自动化测试再写 code_trace**：verify_test.cjs 的真实执行可以帮助发现边界问题，再把这些发现推广到 code_trace case。
- **test_cases_template.json 的测试数据需要与实际代码逻辑对齐**：TC-2-03 的 "invalid {{{" 在写 template 时就没有验证过，说明 template 本身也需要 code review。

### 关键风险

- **code_trace 验证的可信度**：8 个 case 仅通过代码阅读验证，没有运行时证据。如果这些路径有 bug，test_execution.json 无法发现。
- **手动测试覆盖缺口**：TC-4-03~TC-4-05（面板交互）完全没有自动化验证，依赖代码正确性假设。

## Harness 体验

### 流程摩擦

- **Gate 的伪造检测有效**：零失败信号被正确识别为伪造风险。这个机制有实际价值——它迫使测试者认真对待每个 case 而不是批量标通过。
- **修复成本低**：补充 2 条真实失败记录 + 1 个代码发现（TC-2-03 逻辑问题），1 轮修复就通过。

### Gate 质量

- Gate review 准确定位了"全部零失败"这个信号
- 修复后 gate 直接 pass，没有过度要求

### 自动化缺口

- **code_trace case 缺少验证框架**：没有一个标准化的方式记录 code_trace 的证据质量（行号引用、控制流截图等）
- **verify_test.cjs 与 test_execution.json 的关联是手动的**：没有自动从测试输出生成 execution 记录的机制
