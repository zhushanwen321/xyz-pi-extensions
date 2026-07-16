# Retrospect — fix-robustness-medium-batch2

## 概述
4 个 medium 级鲁棒性修复：M6 解耦 worktree cleanup、M9 store.save 防 unhandled rejection、M10 循环引用防护、M12 分离 budget-done 错误处理。

## 教训
- M6 删除 patchOk 变量后产生了空 catch 块（eslint no-empty 阻断），需要改为 bestEffort 日志
- subagent-service.ts 995 行持续在 1000 行上限边缘，每次改动都要压缩注释

## 量化
- commit: 1（5793d2529）, 文件: 4, 测试: 978 passed
