---
name: pull-request
description: >-
  提交 Pull Request。触发词："提交 PR"、"创建 PR"、"push"、"提交代码"、
  "pr-worktree"。仅用于 xyz-pi-extensions 项目。
---

# Pull Request

## 前提

当前在 worktree 目录中。可能有未提交的变更（会先 commit），也可能已全部 commit。

## 步骤

### 1. pre-merge 验证

```bash
# 全量类型检查
pnpm -r typecheck

# 全量 lint
pnpm -r lint

# 全量测试
pnpm -r test

# 构建检查（无需产物，只确认不报错）
pnpm -r build --if-present 2>/dev/null || true
```

**[MANDATORY] 零容忍**：任何失败都必须正面修复，不允许跳过。

`.githooks/pre-commit` 执行相同的检查（tsc + eslint + vitest + pi manifest 校验），pre-merge 验证应与 githook 对齐。

### 2. commit（如有未提交变更）

```bash
git status --porcelain  # 检查是否有未提交变更
```

- 若有未提交变更：用户提供 commit message（或 zcommit 生成），然后 `git add -A && git commit -m "$COMMIT_MSG"`
- 若工作树干净：跳过此步

### 3. 生成 PR title 和 body

**[MANDATORY] 自动从分支所有 commit 生成，无需用户提供。全部使用英文。**

流程：
1. 收集分支相对于 base（main）的所有 commit：
   ```bash
   git log main..HEAD --format="%s%n%b---"
   git diff main..HEAD --stat
   ```
2. 分析所有 commit message 和变更文件，总结本次 PR 的核心改动
3. 生成 PR title：
   - 格式：`fix(scope): short summary` 或 `feat(scope): short summary`（conventional commit 风格）
   - 若涉及多个 scope，用最核心的那个，或用 `fix: short summary` 不带 scope
   - 简洁一行，概括整个分支的改动
4. 生成 PR body（英文）：
   - 用 `## Summary` 段落概括改动目的和内容
   - 用 `## Changes` 列表逐条列出各 commit 的关键改动（合并相关条目，不重复）
   - 若有 changeset 文件，读取其内容一并展示
   - 包含 `## Test plan` 列出验证方式（如已有的 typecheck/test/lint 结果）

### 4. push + 创建/更新 PR

```bash
# push（force-with-lease 安全推送）
git push origin HEAD --force-with-lease
```

判断 PR 是否已存在：
```bash
gh pr list --head $(git branch --show-current) --state open --json number,title,body
```

- **PR 不存在**：创建新 PR
  ```bash
  gh pr create --title "$PR_TITLE" --body "$PR_BODY" --base main
  ```

- **PR 已存在**：比较生成的 title/body 与现有 PR 的 title/body，仅在内容不同时更新
  ```bash
  gh pr edit $PR_NUMBER --title "$PR_TITLE" --body "$PR_BODY"
  ```

## 项目特化

- 验证覆盖所有子包（`pnpm -r`）
- PR 中应包含 changeset 文件（`pnpm changeset` 创建）
- 新增/修改 SKILL.md 时用本目录的 `validate-skill-yaml.py` 校验 frontmatter
- 新增/修改 extensions.yaml 时用本目录的 `validate-extensions-yaml.py` 校验

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
