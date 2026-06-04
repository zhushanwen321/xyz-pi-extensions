#!/bin/bash
# scripts/publish.sh — xyz-pi-extensions 项目发布脚本
#
# 由 merge-worktree 阶段 4 委托调用。
#
# 职责：
#   1. 消费 changeset 文件（如果有）→ bump 子包版本
#   2. bump 根版本号（monorepo 迭代序号）
#   3. commit + tag v{根版本} + push
#
# 调用方式：bash scripts/publish.sh [patch|minor|major]
#
# 环境变量（由 merge-worktree 提供）：
#   WS_ROOT, BRANCH_NAME, PR_NUMBER, VERSION_TYPE
#
# Tag 格式：v{根版本号}（仅用于触发 release.yml CI）
# 实际 npm 发布由 release.yml 中的 pnpm changeset publish 完成

set -euo pipefail

VERSION_TYPE="${1:-patch}"
OP_DIR="$(pwd)"

echo "  发布模式: changeset monorepo (独立版本)"

# ── 步骤 1: 消费 changeset ──
CHANGESET_DIR=".changeset"
PENDING=$(find "$CHANGESET_DIR" -name "*.md" ! -name "README.md" ! -name "config.json" 2>/dev/null | wc -l | tr -d ' ')

if [[ "$PENDING" -gt 0 ]]; then
  echo "  发现 $PENDING 个 changeset 文件，执行 changeset version..."
  pnpm changeset version 2>&1 || {
    echo "  ⚠️  changeset version 失败，继续根版本 bump"
  }
else
  echo "  无待消费的 changeset 文件（子包版本不变）"
fi

# ── 步骤 2: bump 根版本号 ──
CURRENT_ROOT=$(node -p "require('./package.json').version")
npm version "$VERSION_TYPE" --no-git-tag-version 2>&1
NEW_ROOT=$(node -p "require('./package.json').version")
echo "  根版本: $CURRENT_ROOT → $NEW_ROOT"

# ── 步骤 3: 输出被 bump 的子包列表（日志用）──
BUMPED=""
if [[ "$PENDING" -gt 0 ]]; then
  BUMPED=$(git diff --name-only --cached -- 'extensions/*/package.json' 2>/dev/null || git diff --name-only -- 'extensions/*/package.json' 2>/dev/null || echo "")
  if [[ -n "$BUMPED" ]]; then
    echo "  已 bump 的子包:"
    echo "$BUMPED" | while read -r f; do
      PKG_NAME=$(node -p "require('./$f').name" 2>/dev/null || echo "(unknown)")
      PKG_VER=$(node -p "require('./$f').version" 2>/dev/null || echo "?")
      echo "    - $PKG_NAME → $PKG_VER"
    done
  fi
fi

# ── 步骤 4: commit + tag + push ──
git add -A
git commit -m "chore: bump versions (root $CURRENT_ROOT → $NEW_ROOT)" 2>/dev/null || echo "  无变更需提交"

TAG="v$NEW_ROOT"
git tag "$TAG" 2>/dev/null || echo "  Tag $TAG 已存在"
git push origin HEAD:refs/heads/main --tags 2>&1 | tail -1

echo "  ✅ 发布准备完成: tag=$TAG"
