---
verdict: pass
must_fix: 0
---

# Spec Review v2 — Ad-hoc Workflow Generation

## 修复验证

v1 发现 10 条 MUST_FIX，逐一验证：

| # | v1 问题 | 修复状态 |
|---|--------|---------|
| 1 | 缺少 Outcomes 节 | ✅ 已补充 Outcomes 节 |
| 2 | 缺少 Decisions 节 | ✅ 已补充 Decisions 节（7 个决策，含选择/原因/替代方案） |
| 3 | 缺少 Verification 节 | ✅ 已补充 Verification 节 |
| 4 | FR2.2 自动 -2 后缀 vs FR3.3 拒绝覆盖冲突 | ✅ 统一为拒绝+报错策略，FR2.2 和 FR3.3 行为一致 |
| 5 | 同名 saved/tmp 优先级未定义 | ✅ FR4.5 明确优先级：.tmp > .pi/workflows > ~/.pi/agent/workflows |
| 6 | "确认"机制未定义 | ✅ FR1.3 明确：AI 展示路径后自然停顿，等用户下一轮输入确认 |
| 7 | "匹配"标准未定义 | ✅ FR1.2 明确优先级：精确 name → description 关键词 → AI 语义判断 |
| 8 | 用户级 workflow 路径被忽略 | ✅ FR4.3/FR4.4/FR4.5 覆盖三目录；FR3.5 限定保存范围 |
| 9 | 错误场景未覆盖 | ✅ FR2.2 语法错误返回 isError；FR6.3 运行中拒绝删除；Constraints 覆盖 IO |
| 10 | 交互面板 Save 底层逻辑未定义 | ✅ FR6.2 明确复用 commands.ts save handler |

## 新增内容检查

- AC9: 名称冲突重试验证 ✅
- AC10: .tmp 目录自动创建 ✅
- Complexity Assessment 升级为 L2 ✅

## 结论

所有 10 条 MUST_FIX 已修复。spec 结构完整（6 元素全覆盖），FR 无矛盾，AC 可测试。
