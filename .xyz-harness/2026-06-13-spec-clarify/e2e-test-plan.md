---
verdict: pass
---

# E2E Test Plan — spec-clarify skill 改造

## Test Scenarios

### 场景 1: 静态完整性验证（自动化）

验证改造后的 skill 文件结构、引用一致性、旧机制零残留。

**覆盖 AC:** AC-5（范围控制）

**验证步骤:**
1. 运行 Task 9 Step 1-4 的所有验证命令
2. 确认 references 目录为预期的 4 个文件
3. 确认旧机制关键词零残留
4. 确认新设计核心元素存在
5. 确认 index.ts 路由 + track.md 引用一致

### 场景 2: TypeScript 类型检查（自动化）

验证 index.ts 改动不引入类型错误。

**覆盖 AC:** 无直接 AC，但保证不破坏构建

**验证步骤:**
1. `pnpm --filter @zhushanwen/pi-coding-workflow typecheck`
2. 预期零错误

### 场景 3: brainstorming skill 完整性（自动化）

验证 brainstorming skill 保留不动（选项 1 的约束）。

**验证步骤:**
1. 确认 `extensions/coding-workflow/skills/xyz-harness-brainstorming/SKILL.md` 存在
2. 确认行数为 516（不变）

### 场景 4: 实际加载流程测试（手动）

启动 Pi，手动走一遍 spec-clarify 流程，验证 skill 指令可被 AI 正确执行。

**覆盖 AC:** AC-1, AC-3, AC-4（端到端验证）

**测试环境:**
- Pi 已安装 `@zhushanwen/pi-coding-workflow` 最新版本（含改造后的 skill）
- 一个简单的测试需求（如"给某列表加导出按钮"）

**验证步骤:**
1. 启动 Pi，输入 `/dev` 或触发 Phase 1
2. 确认加载的是 spec-clarify skill（非 brainstorming）
3. 观察 AI 是否执行 Quick Overview + 交互提问
4. 观察是否派出独立 subagent 做追踪（关键验证点）
5. 观察 gap 处理是否走 F/K/D 分流
6. 观察收敛后是否调用 gate

**预期结果:** AI 按 SKILL.md 指令执行，subagent 被正确派发，gap 被正确分类处理。

**注意:** 这是手动验证。skill 指令是"软"约束（D-5），AI 可能不完全严格执行——如果执行偏离较大，记录到 retrospect，分析是否需要 tool 化（后续 subagent extension 就绪后）。

## Test Environment

- Node.js v24+
- pnpm workspace（xyz-pi-extensions monorepo）
- Pi coding agent（开发版，加载本地 extension）
- 测试需求：一个简单的前端功能需求
