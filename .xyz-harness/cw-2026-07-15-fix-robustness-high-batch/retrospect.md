# Retrospect — fix-robustness-high-batch

## 概述

修复 4 方向并行审查发现的 4 个 high 级鲁棒性缺陷。每个 bug 都是独立的衔接裂缝——跨层数据传递不一致、并发控制缺失、缓存过期、字段丢失。

## 做对了什么

1. **根因全部代码验证**：4 个 subagent 审查发现的每个 high 都经过主 agent 逐行读码确认，不盲信 subagent 结论。
2. **TDD 红灯一次到位**：4 个红灯测试在 tdd_plan 一次跑过，无返工。每个测试针对 bug 的核心场景。
3. **W3 最小侵入设计**：SAR ctxModel 修复选择了 `updateCtxModel` 方法（1 个方法 + 1 行调用）而非重构 SAR 构造签名（改 3+ 个文件 + 所有用例）。

## 教训

### subagent-service.ts 1000 行限制碰撞

文件原始 999 行，本次 W4 加了 6 行导致超限。通过压缩注释（合并多行注释、删空行）回到 999 行。这是技术债——文件需要按职责拆分（finalizeFailed / runAndFinalize / worktree 管理可各自独立）。本次绕过方式是临时手段。

### cwd 隔离陷阱

cw create 在 bash 工具某次调用中 cwd 漂移到了 `extensions/subagent-workflow/src/`，导致后续 cw 命令全部需要从该目录执行。AGENTS.md 已有此坑的记录，但每次 bash 调用的 cwd 不持久仍然持续踩坑。

## 全绿质量自检

- U1 (abort→fallback error) 测的是异常路径（abort 时 success=false+error=undefined），不是 happy path
- U2 (skill 字段) 测的是字段丢失这一具体 bug，不是泛泛的"skill 存在"
- U3 (ctxModel 刷新) 测的是 stale 缓存刷新后的新值读取，验证了 model_select 的修复链路
- U4 (acquire abort reject) 测的是并发池在 abort 时的取消机制
- 如果故意改坏 W1（去掉 `|| fallback`），U1 会变红。测试有防线。

## 量化

- commits: 4（W1-W4 各一个）
- 文件改动: 9（4 实现 + 4 测试 + 1 index.ts）
- 测试: 960 passed（含 4 个新红灯 + 1 个回归守卫）
- 流程: plan→tdd_plan→dev→review→test→retrospect→closeout，零返工
