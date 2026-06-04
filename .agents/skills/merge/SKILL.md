---
name: merge
description: >-
  合并分支并发布。触发词："合并"、"merge"、"发布"、"release"、
  "上线"。仅用于 xyz-pi-extensions 项目。
---

# Merge

## 8 阶段流程

### 阶段 0: 初始化

⚠️ **关键**：第一个参数是 **feature worktree 目录名**（如 `feat-add-extension`），不是 `main`。脚本会自动检测 `$WS_ROOT/main` 用于 bump/tag/push。传 `main` 会导致阶段 7 删除 main worktree。

```bash
CURRENT_WT=$(basename $(pwd))  # 如果从 feature worktree 的上级目录调用
cd /Users/zhushanwen/Code/xyz-pi-extensions-workspace
bash ~/.agents/skills/merge-worktree/stages/0-init.sh $CURRENT_WT patch
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

### 阶段 4: 版本 bump + 发布

全局 `4-publish.sh` 会自动检测 `scripts/publish.sh` 并委托执行（含 changeset 消费 + bump 根版本 + tag + push）。

```bash
bash ~/.agents/skills/merge-worktree/stages/4-publish.sh
```

**changeset 注意**：PR 中必须包含 `pnpm changeset` 创建的 changeset 文件，否则 merge 后子包不会 bump。

### 阶段 5: Release Notes + Release
```bash
bash ~/.agents/skills/merge-worktree/stages/5-release.sh
```

### 阶段 6: 交付物验证（项目特化）

以下验证脚本已在本地，直接执行即可：

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

---

## 标记说明

| 标记 | 含义 | 修改约束 |
|------|------|----------|
| `[MANDATORY]` | 流程强制要求。不遵守会导致流程失败或产生严重后果 | 必须严格遵守 |
| `[OPTIONAL]` | 可选步骤。可根据实际情况决定是否执行 | 可根据项目需求调整 |
