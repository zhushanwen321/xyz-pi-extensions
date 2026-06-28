#!/bin/bash
# 共享函数库：workspace 操作相关
# 被 create-worktree.sh, merge-worktree.sh 等脚本 source 使用

# 从当前目录向上查找 workspace 根（包含 .bare/ 的目录）
find_workspace_root() {
    local dir="$1"
    while [[ "$dir" != "/" ]]; do
        if [[ -d "$dir/.bare" ]]; then
            echo "$dir"
            return 0
        fi
        dir="$(cd "$dir/.." && pwd)"
    done
    return 1
}

# 获取当前分支名
get_current_branch() {
    git rev-parse --abbrev-ref HEAD 2>/dev/null
}

# 清理 worktree + 可选删除分支
remove_worktree() {
    local workspace_root="$1"
    local branch_name="$2"
    local delete_branch="${3:-false}"
    local dir_name="${branch_name//\//-}"
    local worktree_path="$workspace_root/$dir_name"

    if [[ ! -d "$worktree_path" ]]; then
        echo "Error: worktree '$dir_name' 不存在。"
        return 1
    fi

    # 检查未提交/未跟踪的更改
    local has_changes=false
    if ! git -C "$worktree_path" diff --quiet 2>/dev/null || \
       ! git -C "$worktree_path" diff --cached --quiet 2>/dev/null; then
        has_changes=true
    fi
    # 检查 untracked 文件
    local untracked
    untracked=$(git -C "$worktree_path" ls-files --others --exclude-standard 2>/dev/null)
    if [[ -n "$untracked" ]]; then
        has_changes=true
    fi
    if $has_changes; then
        echo "Error: '$dir_name' 有未提交/未跟踪的更改，请先提交或 stash。"
        git -C "$worktree_path" status --short
        return 1
    fi

    # 删除 worktree（git -C 确保在正确目录操作）
    echo "删除 worktree '$dir_name'..."
    git -C "$workspace_root/.bare" worktree remove "$worktree_path"

    # 可选删除分支
    if $delete_branch; then
        if git -C "$workspace_root/.bare" rev-parse --verify "$branch_name" >/dev/null 2>&1; then
            echo "删除本地分支 '$branch_name'..."
            git -C "$workspace_root/.bare" branch -d "$branch_name" 2>/dev/null || \
                git -C "$workspace_root/.bare" branch -D "$branch_name"
        fi
    fi
}

# 检查 worktree 是否干净（无未提交变更）
is_worktree_clean() {
    local workspace_root="$1"
    local branch_name="$2"
    local dir_name="${branch_name//\//-}"
    git -C "$workspace_root/$dir_name" diff --quiet 2>/dev/null && \
    git -C "$workspace_root/$dir_name" diff --cached --quiet 2>/dev/null
}

# 获取所有 worktree 目录（排除 .bare 和 node_modules）
list_worktrees() {
    local workspace_root="$1"
    for wt in "$workspace_root"/*/; do
        local name
        name="$(basename "$wt")"
        [[ "$name" == ".bare" || "$name" == "node_modules" ]] && continue
        echo "$name"
    done
}
