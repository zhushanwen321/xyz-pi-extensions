---
template: merge-skill-symlink-cleanup
created: "2026-06-12"
status: done
---

# Plan: Merge Skill 增加 Dev-Link Symlink 清理

## Overview

Merge skill 缺少 worktree symlink 清理步骤。Stage 7 删除 worktree 后 symlink 会变成 dangling link，导致 Pi 加载失败。需要在 merge 流程中加入 symlink 检测和清理。

## Problem Analysis

### 当前问题

1. 开发时通过 `link-local.sh` 创建 symlink 指向 worktree
2. Stage 7 删除 worktree 后 symlink dangling，Pi 启动报错
3. 用户必须手动清理，容易遗漏

### 关联影响

- **全新 extension**：npm 上不存在包，`link-npm.sh` 会失败，需直接删除 symlink
- **已有 extension**：可以用 `link-npm.sh` 恢复到 npm 版本
- **未变更但被 symlink 的 extension**：只要有 symlink 指向当前 worktree 就必须清理

## Design Decisions

### D1: 放在哪个阶段？

**决定：在 Stage 1 和 Stage 2 之间插入 Stage 1.5。**

理由：
- Stage 0 建立了 worktree 上下文
- Stage 1 验证了代码质量
- Stage 1.5 清理 symlink，确保环境干净
- Stage 2 才开始远程操作

不放在 Stage 7 的理由：太晚了，合并过程中 Pi 可能被使用，dangling symlink 已经会造成问题。

### D2: 检测逻辑

1. **PR 变更检测**：`git diff --name-only main...HEAD -- extensions/` 列出本次 PR 修改的 extension
2. **Symlink 检测**：扫描 `~/.pi/agent/extensions/` 所有 symlink，匹配指向当前 worktree 路径的
3. **npm 可用性检测**：`npm view @zhushanwen/pi-<name> version` 判断是否已发布

### D3: 清理策略

| 场景 | 处理 | 理由 |
|------|------|------|
| 已发布到 npm | `link-npm.sh <name>` | 恢复到 npm 版本，CI 发布后 pi install 升级 |
| 全新 extension | 删除 symlink + 清理 settings.json | npm 包不存在，无法 link-npm |
| 不指向当前 worktree | 跳过 | 不属于本次 merge 范围 |

### D4: 是否需要新增脚本？

**不需要**。`link-npm.sh` 已覆盖 npm 恢复场景。全新 extension 的删除逻辑只需几行 shell，内联在 SKILL.md 中即可。

## Implementation Steps

### Step 1: SKILL.md — 在 Stage 1 和 Stage 2 之间插入 Stage 1.5

新增 "阶段 1.5: Dev-Link Symlink 清理 [MANDATORY]" 章节，含 4 个子步骤：

1. 1.5.1 列出本次 PR 变更的 extension
2. 1.5.2 检测指向当前 worktree 的 symlink
3. 1.5.3 按 npm 可用性分别处理
4. 1.5.4 验证清理结果

### Step 2: SKILL.md — "项目特化要点" 增加 dev-link 条目

增加一条说明 merge 前必须清理 symlink 的强制约束。

### Step 3: SKILL.md — Stage 7 增加 dangling symlink 最终确认

在现有 stage 7 命令后追加 dangling symlink 检查，作为安全网。

## Risks & Mitigations

| 风险 | 缓解 |
|------|------|
| `link-npm.sh` 安装的是旧版本 | 可接受。CI 发布后用户 `pi install` 升级即可 |
| 全新 extension merge 后用户忘记 install | Stage 6 验证环节已覆盖（检查 npm 包是否存在） |
| settings.json 被意外清空 | 脚本只做 filter 操作，不覆写整个文件 |
| symlink 指向其他 worktree | 检测只匹配当前 worktree 路径，不会误操作 |
