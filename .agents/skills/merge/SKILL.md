---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。执行 8 阶段合并发布流程，changeset 独立版本模式，
  npm registry 交付物验证。仅用于 xyz-pi-extensions 项目。
---

# Merge

## 8 阶段流程

### 阶段 0: 初始化
```bash
cd ~/Code/xyz-pi-extensions-workspace
bash ~/.agents/skills/merge-worktree/stages/0-init.sh main patch
```

### 阶段 1: 本地验证
```bash
bash ~/.agents/skills/merge-worktree/stages/1-local-check.sh
```

### 阶段 2: PR CI + 合并
```bash
bash ~/.agents/skills/merge-worktree/stages/2-pr-merge.sh
```

### 阶段 3: Post-merge CI
```bash
bash ~/.agents/skills/merge-worktree/stages/3-post-merge-ci.sh
```

### 阶段 4: 版本 bump + 发布（项目特化）

本项目使用 changeset 独立版本模式：

```bash
# 消费 changeset
pnpm changeset version

# bump 根版本（monorepo 迭代序号）
npm version patch --no-git-tag-version
NEW_VER=$(node -p "require('./package.json').version")

# commit + tag + push
git add -A
git commit -m "chore: bump versions (root → $NEW_VER)" 2>/dev/null || true
TAG="v$NEW_VER"
git tag "$TAG" 2>/dev/null || echo "Tag $TAG 已存在"
git push origin HEAD:refs/heads/main --tags
```

### 阶段 5: Release Notes + Release
```bash
bash ~/.agents/skills/merge-worktree/stages/5-release.sh
```

### 阶段 6: 交付物验证（项目特化）

验证 npm registry 包：

```bash
for f in extensions/*/package.json shared/*/package.json; do
  PKG_NAME=$(node -p "require('$f').name" 2>/dev/null)
  PKG_VER=$(node -p "require('$f').version" 2>/dev/null || echo "?")
  if [ -n "$PKG_NAME" ]; then
    npm view "$PKG_NAME@$PKG_VER" version 2>/dev/null && \
      echo "  $PKG_NAME@$PKG_VER" || echo "  MISSING: $PKG_NAME@$PKG_VER"
  fi
done
```

### 阶段 7: 清理
```bash
bash ~/.agents/skills/merge-worktree/stages/7-cleanup.sh
```

## 项目特化要点

- **版本管理**：changeset 独立版本，子包版本各不同
- **发布委托**：`scripts/publish.sh` 消费 changeset + bump 根版本
- **交付物**：npm registry 包，无 GitHub Release assets
- **Custom Hooks**：当前无
