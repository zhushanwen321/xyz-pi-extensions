---
verdict: pass
---

# Non-Functional Design — spec-clarify skill 改造

## 1. 稳定性

改造对象是 Markdown skill 文件 + 1 行 TS 路由。改动范围限于 `extensions/coding-workflow/skills/xyz-harness-spec-clarify/` 目录和 index.ts/track.md 的引用更新。不触及任何运行时逻辑、状态管理或数据流。风险点在于 index.ts 路由变更——如果 skillName 写错，Phase 1 会加载失败。缓解：Task 7 Step 2 类型检查 + Task 9 Step 4 路由一致性检查。

## 2. 数据一致性

不涉及数据存储变更。skill 文件是静态 Markdown，由 Pi 的 skill loader 按 name 字段加载。改造后 `name: xyz-harness-spec-clarify` 必须与 index.ts 的 `skillName: "xyz-harness-spec-clarify"` 完全一致（basename 匹配）。clarification.md 重命名（原 clarification-model.md）后，SKILL.md 中的 read 路径必须同步更新。

## 3. 性能

skill 文件加载是 Pi 启动时的一次性操作，改造不影响运行时性能。references 从 6 个精简到 4 个，总行数从 1081 行预计降到 ~500 行，减少主 agent 和 subagent 的 context 占用。subagent 追踪的"完整重跑 5 视角"成本已被 spec 接受（简单需求 1-2 轮收敛，可接受）。

## 4. 业务安全

skill 文件作为 AI 行为指令。新设计把追踪职责交给独立 subagent（隔离上下文），主 agent 只做交互。这个职责分离本身降低了"主 agent 带着确认偏误自圆其说"的风险。F 类二次确认机制防止 subagent 误报打扰用户。无外部输入处理、无敏感信息访问。

## 5. 数据安全

skill 文件不涉及敏感信息处理。references 中的追踪模板、gap 分类规则是公开的设计知识。subagent 的 task prompt 模板会包含 `{topic_dir}` 占位符，运行时由主 agent 填充实际路径——不硬编码任何绝对路径。文件操作仅限 `.xyz-harness/{topic}/` 目录下的读写。
