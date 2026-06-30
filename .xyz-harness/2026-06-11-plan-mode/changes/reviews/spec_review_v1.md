---
verdict: pass
must_fix: 0
review:
  type: spec_review
  round: 1
  timestamp: "2026-06-11T14:30:00"
  target: ".xyz-harness/2026-06-11-plan-mode/spec.md"
  summary: "spec 评审通过。10 个功能区块（FR-1~FR-10）覆盖 plan mode 完整生命周期，AC 全部可验证，约束明确，4 个核心 use case 已列出。"

statistics:
  total_issues: 7
  must_fix: 0
  must_fix_resolved: 0
  low: 4
  info: 3

issues:
  - id: L1
    severity: low
    title: "FR-5.6/5.7 的「与 coding-workflow 一致」表述不准确"
    location: "spec.md:73-74, 140"
    description: |
      spec 多次声明 session_before_compact / session_before_tree handler 是「与 coding-workflow 一致的实现模式」，
      但 coding-workflow 实际并不使用 session_before_compact / session_before_tree 事件。
      验证证据：
        - grep -rn 'session_before' extensions/coding-workflow/  → 零结果
        - coding-workflow 的 compact 流程使用 ctx.compact({customInstructions, onComplete, onError})
          （lib/tool-handlers.ts:554），并通过 pi.sendUserMessage({deliverAs: "steer"}) + ctx.ui.notify
          做降级处理（lib/tool-handlers.ts:565-585）。
      准确描述：plan mode 的 ctx.compact() 调用模式与 coding-workflow 一致（FR-5.3），
      而 session_before_compact handler 是 plan mode 新增的机制（用于处理「非编程式 compact 触发
      场景」如自动 compact、tree 回退的摘要自定义），不是从 coding-workflow 复用的模式。
    recommendation: "把 FR-5.6/5.7 的「与 coding-workflow 一致」改为「plan mode 新增机制」并说明用途。"
  - id: L2
    severity: low
    title: "未声明可选运行时依赖 pi-ask-user / pi-subagents"
    location: "spec.md:FR-2.3, FR-6.1"
    description: |
      spec 在 FR-2.3 提到「如已安装 pi-ask-user」、在 FR-6.1 提到「检查 pi-subagents 包是否已安装」，
      说明 plan mode 强依赖这两个可选扩展。但 Constraints 段只列出了 Goal 依赖（`__goalInit`），
      没有把 pi-ask-user / pi-subagents 列入「optional runtime dependency」清单。
      设计文档（plan-mode-design.md 第 10 节）已经规划在 extension-dependencies.json 中声明，
      spec 应该与之保持一致。
    recommendation: "在 Constraints 段补充：plan mode 是 pi-ask-user 和 pi-subagents 的可选消费方，缺失时降级为对话式提问和单 agent 执行。"
  - id: L3
    severity: low
    title: "/plan status 子命令未在 spec 中显式声明"
    location: "spec.md:FR-1.3, FR-1.4"
    description: |
      设计文档 5.5 节列出 3 个子命令：/plan <描述>、/plan、/plan abort、/plan status。
      spec 中只显式提到前 3 个，未声明 /plan status。FR-1.4 仅描述了「在 plan mode 中输入 /plan」
      显示状态，没有单独的 status 子命令。
    recommendation: "二选一：(a) 在 FR-1.4 显式添加 /plan status 子命令；或 (b) 删除设计文档中提到的 /plan status 以保持一致。"
  - id: L4
    severity: low
    title: "FR-1.3 描述「已有 plan 文件」时未指定扫描路径"
    location: "spec.md:FR-1.3, FR-1.6"
    description: |
      FR-1.6 规定 plan 文件路径为 /tmp/plan-{slug}.md，但 FR-1.3 说「检测已有 plan 文件并提示用户选择」
      没有指明从哪个目录扫描（/tmp 整个目录？glob 模式 plan-*.md？包括用户家目录下的其他位置？）。
      这会导致实现时出现两种解读。
    recommendation: "明确扫描路径为 /tmp/plan-*.md（glob 模式），并说明如何排除非 plan-mode 创建的同名文件。"

  - id: I1
    severity: info
    title: "FR-2.9（B2-B4 循环）与 FR-3.5（一次 turn 写完所有章节）之间的转换点不够明确"
    location: "spec.md:FR-2.9, FR-2.10, FR-3.5"
    description: |
      FR-2.10 规定「进入 Phase C 的条件：用户说『开始写 plan』或 AI 判断信息充分主动提议」。
      FR-3.5 规定「AI 一次 turn 写完所有章节」。
      但未说明：进入 Phase C 后用户提出新想法（如「方案 2 不对，重新分析」），应该回到 Phase B 还是
      在 Phase C 内部修订 plan 文件？spec 缺乏明确的「阶段回退」规则。
      设计文档 5.3 列出的 phase 枚举是 setup/brainstorm/writing/review/done，没有 review 阶段
      的回退规则。
    recommendation: "补充：进入 Phase C 后用户提出修改方向，AI 提示用户选择「修改 plan 文件（保持在 C 阶段）」或「回退到 B 阶段重新 brainstorm」。"
  - id: I2
    severity: info
    title: "UC 覆盖度低于设计文档（UC-1~UC-4 vs 设计文档 UC-1~UC-11）"
    location: "spec.md:业务用例"
    description: |
      spec 列了 4 个 use case（UC-1 新功能、UC-2 bugfix、UC-3 调研、UC-4 已有 spec）。
      设计文档列了 11 个 use case + Edge Cases + Out of Scope。
      UC-6（plan 迭代修改）、UC-7（中途切换到 plan mode）、UC-9（查看已有 plan）这些重要场景
      在 spec 中虽然通过 FR-1.3/1.4/1.8/3.4 等功能要求覆盖了，但业务价值没有显式说明。
    recommendation: "可选：把设计文档的 UC-6/UC-7/UC-9 也纳入 spec 的业务用例章节（用 1-2 行说明），帮助后续测试用例规划。"
  - id: I3
    severity: info
    title: "FR-1.7 描述的 plan-mode 系统提示词内容未列出"
    location: "spec.md:FR-1.7"
    description: |
      FR-1.7 规定「通过 skill 加载 plan mode 系统提示词（只读约束 + 流程指引）」，
      但没有列出提示词应包含的具体条目。设计文档 5.6 节列出了 8 条（只读约束、流程指引、
      提问策略、方案探索、假设审计、章节顺序、退出方式、重入处理）。
    recommendation: "可选：在 FR-1.7 注释「具体内容见 plan-mode-design.md 5.6」即可，不必在 spec 中展开。"

notes:
  - "FR-1.6 路径规范 /tmp/plan-{slug}.md 与设计文档 6.1 一致；slug 命名建议补充「使用随机 word + 数字」避免冲突"
  - "FR-2.4 / FR-2.5（先探索再提问、区分两类未知数）吸取了 Codex 经验，是 spec 的亮点，应在 SKILL.md 中严格落地"
  - "FR-8.2 显式声明「仅通过提示词实现，不用 tool_call 拦截」与 ADR-021 决策一致"
  - "FR-9.1 / FR-9.2 / FR-9.3（sessionManager + appendEntry + session_start 重建）与 ADR-022 决策一致"
  - "FR-6.4 使用 `__goalInit` 与 coding-workflow 一致（lib/tool-handlers.ts:504/525）；设计文档 5.8 节提到的 `startGoalFromPlan` 是错误表述，extensions/goal/src/index.ts 实际只暴露 `__goalInit`（line 422）"
  - "5 个内置模板（feature/bugfix/refactor/research/implementation）的覆盖度合理"
  - "Constraints 段的「运行环境」「状态存储」「上下文隔离」三项硬性约束与 FR / ADR 完全对齐，迁移到 plan 阶段时无需重新讨论"
  - "AC-1~AC-11 全部可验证，没有「AI 应该……」这类不可测试的描述"
  - "Complexity Assessment 标为「中等复杂度」合理：核心机制（状态管理、compact、goal API）均有现成实现可参考，新增工作集中在 plan tool action handler、模板系统、SKILL.md 提示词"
