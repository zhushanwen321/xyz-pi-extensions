#!/usr/bin/env bash
# lightmerge.sh - 多分支测试合并工具
# 用法见 SKILL.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_BASE_DIR="$HOME/.claude/lightmerge-data"
STATE_FILE=""  # 重建状态文件路径，冲突暂停时写入

# ─── 工具函数 ────────────────────────────────────────────

get_config_path() {
    local project_name="$1"
    echo "${CONFIG_BASE_DIR}/${project_name}/lightmerge-branches.json"
}

ensure_config_dir() {
    local project_name="$1"
    local config_dir="${CONFIG_BASE_DIR}/${project_name}"
    mkdir -p "$config_dir"
}

read_config() {
    local config_path="$1"
    if [[ ! -f "$config_path" ]]; then
        echo "错误: 配置文件不存在: ${config_path}" >&2
        echo "请先运行 init 命令初始化。" >&2
        exit 1
    fi
    cat "$config_path"
}

write_config() {
    local config_path="$1"
    local config_content="$2"
    echo "$config_content" > "$config_path"
}

# 用 python3 解析 JSON（macOS 自带，无额外依赖）
json_get() {
    local config_path="$1"
    local key="$2"
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
result = data.get(sys.argv[2], '')
if isinstance(result, list):
    print(json.dumps(result))
else:
    print(result)
" "$config_path" "$key"
}

json_set() {
    local config_path="$1"
    local key="$2"
    local value="$3"
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
data[sys.argv[2]] = json.loads(sys.argv[3])
with open(sys.argv[1], 'w') as f:
    json.dump(data, f, indent=2, ensure_ascii=False)
print(json.dumps(data, indent=2, ensure_ascii=False))
" "$config_path" "$key" "$value"
}

json_array_append() {
    local config_path="$1"
    local key="$2"
    local new_item="$3"
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
arr = data.get(sys.argv[2], [])
if sys.argv[3] not in arr:
    arr.append(sys.argv[3])
    data[sys.argv[2]] = arr
    with open(sys.argv[1], 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(json.dumps(data, indent=2, ensure_ascii=False))
else:
    print('已存在:', sys.argv[3])
    print(json.dumps(data, indent=2, ensure_ascii=False))
" "$config_path" "$key" "$new_item"
}

json_array_remove() {
    local config_path="$1"
    local key="$2"
    local item="$3"
    python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
arr = data.get(sys.argv[2], [])
if sys.argv[3] in arr:
    arr.remove(sys.argv[3])
    data[sys.argv[2]] = arr
    with open(sys.argv[1], 'w') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(json.dumps(data, indent=2, ensure_ascii=False))
else:
    print('不存在:', sys.argv[3])
    print(json.dumps(data, indent=2, ensure_ascii=False))
" "$config_path" "$key" "$item"
}

# ─── 获取项目名（git 仓库目录名）───

get_project_name() {
    basename "$(git rev-parse --show-toplevel 2>/dev/null || echo "unknown-project")"
}

# ─── 命令实现 ────────────────────────────────────────────

cmd_init() {
    local project_name="${1:-$(get_project_name)}"
    local base_branch="${2:-main}"
    local remote="${3:-origin}"
    local lm_branch="${4:-lightmerge}"
    local config_path

    config_path=$(get_config_path "$project_name")
    ensure_config_dir "$project_name"

    if [[ -f "$config_path" ]]; then
        echo "配置文件已存在: ${config_path}"
        echo "当前配置:"
        cat "$config_path"
        echo ""
        echo "如需重置，请手动删除配置文件后重新 init。"
        exit 0
    fi

    cat > "$config_path" << EOF
{
  "base_branch": "${base_branch}",
  "lightmerge_branch_name": "${lm_branch}",
  "remotes": ["${remote}"],
  "branches": []
}
EOF

    echo "初始化完成"
    echo "配置文件: ${config_path}"
    echo ""
    echo "当前配置:"
    cat "$config_path"
    echo ""
    echo "下一步: 使用 add <branch> 添加要合并的分支"
}

cmd_add() {
    local project_name="${1:-$(get_project_name)}"
    local branch_name="$2"
    local config_path

    if [[ -z "$branch_name" ]]; then
        echo "错误: 请指定要添加的分支名" >&2
        echo "用法: lightmerge.sh add <project-name> <branch-name>" >&2
        exit 1
    fi

    config_path=$(get_config_path "$project_name")

    echo "添加分支: ${branch_name}"
    json_array_append "$config_path" "branches" "$branch_name"

    echo ""
    cmd_rebuild "$project_name"
}

cmd_remove() {
    local project_name="${1:-$(get_project_name)}"
    local branch_name="$2"
    local config_path

    if [[ -z "$branch_name" ]]; then
        echo "错误: 请指定要移除的分支名" >&2
        echo "用法: lightmerge.sh remove <project-name> <branch-name>" >&2
        exit 1
    fi

    config_path=$(get_config_path "$project_name")

    echo "移除分支: ${branch_name}"
    json_array_remove "$config_path" "branches" "$branch_name"

    echo ""
    cmd_rebuild "$project_name"
}

cmd_rebuild() {
    local project_name="${1:-$(get_project_name)}"
    local config_path
    local base_branch
    local lm_branch
    local branches_json
    local remotes_json

    config_path=$(get_config_path "$project_name")
    STATE_FILE="${CONFIG_BASE_DIR}/${project_name}/.rebuild-state.json"

    # 读取配置
    base_branch=$(json_get "$config_path" "base_branch")
    lm_branch=$(json_get "$config_path" "lightmerge_branch_name")
    branches_json=$(json_get "$config_path" "branches")
    remotes_json=$(json_get "$config_path" "remotes")

    # 解析 branches 数组
    local branches=()
    while IFS= read -r line; do
        line=$(echo "$line" | tr -d '"' | xargs)
        if [[ -n "$line" ]]; then
            branches+=("$line")
        fi
    done < <(echo "$branches_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for item in data:
    print(item)
")

    # 解析 remotes 数组
    local remotes=()
    while IFS= read -r line; do
        line=$(echo "$line" | tr -d '"' | xargs)
        if [[ -n "$line" ]]; then
            remotes+=("$line")
        fi
    done < <(echo "$remotes_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for item in data:
    print(item)
")

    echo "=== 重建 lightmerge 分支 ==="
    echo "Base branch: ${base_branch}"
    echo "Lightmerge branch: ${lm_branch}"
    echo "合并列表 (${#branches[@]} 个分支):"
    for i in "${!branches[@]}"; do
        echo "  $((i+1)). ${branches[$i]}"
    done
    echo ""

    # 保存当前分支，以便后续恢复
    local current_branch
    current_branch=$(git branch --show-current)
    trap 'echo "重建失败，恢复原分支..."; git checkout "$current_branch" 2>/dev/null || true' ERR

    # 拉取 base_branch 最新代码（从配置的 remotes 中依次尝试）
    echo "更新 ${base_branch}..."
    local fetched=false
    for remote in "${remotes[@]}"; do
        if git fetch "${remote}" "${base_branch}"; then
            fetched=true
            break
        fi
    done
    if [[ "$fetched" == false ]]; then
        echo "  警告: 未能从任何 remote 拉取 ${base_branch}，使用本地版本"
    fi
    git checkout "${base_branch}" 2>/dev/null || git checkout "FETCH_HEAD" -b "${base_branch}" 2>/dev/null
    if [[ $? -ne 0 ]]; then
        echo "错误: 无法切换到 ${base_branch}" >&2
        exit 1
    fi
    for remote in "${remotes[@]}"; do
        git pull "${remote}" "${base_branch}" 2>/dev/null && break || true
    done

    # 预取所有待合并分支的最新代码
    echo "预取待合并分支..."
    for branch in "${branches[@]}"; do
        # 只 fetch 远端上的分支（本地分支已最新）
        if ! git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then
            for remote in "${remotes[@]}"; do
                git fetch "${remote}" "${branch}" 2>/dev/null && break || true
            done
        fi
    done

    # 删除旧的 lightmerge 分支
    if git show-ref --verify --quiet "refs/heads/${lm_branch}"; then
        echo "删除旧的 ${lm_branch} 分支..."
        git branch -D "${lm_branch}"
    fi

    # 删除远端的 lightmerge 分支（所有 remote）
    for remote in "${remotes[@]}"; do
        if git show-ref --verify --quiet "refs/remotes/${remote}/${lm_branch}"; then
            echo "删除远端 ${remote}/${lm_branch}..."
            git push "${remote}" --delete "${lm_branch}" 2>/dev/null || true
        fi
    done

    # 从 base_branch 创建新的 lightmerge 分支
    echo "创建 ${lm_branch} 分支（基于 ${base_branch}）..."
    git checkout -b "${lm_branch}" "${base_branch}"

    # 写入重建状态文件（用于冲突恢复）
    _write_rebuild_state "$project_name" "$base_branch" "$lm_branch" "$current_branch" \
        "$(printf '%s\n' "${remotes[@]}")" \
        "$(printf '%s\n' "${branches[@]}")" \
        "0" "" "full"

    # 合并循环前取消 trap，避免冲突暂停时也触发恢复
    trap - ERR

    # 逐个合并分支
    _do_merge_loop "$project_name" "$lm_branch" "0"
}

cmd_list() {
    local project_name="${1:-$(get_project_name)}"
    local config_path
    config_path=$(get_config_path "$project_name")

    if [[ ! -f "$config_path" ]]; then
        echo "尚未初始化。请先运行 init 命令。"
        exit 0
    fi

    echo "配置文件: ${config_path}"
    echo ""
    cat "$config_path"
    echo ""

    # 检查 lightmerge 分支状态
    local lm_branch
    lm_branch=$(json_get "$config_path" "lightmerge_branch_name")

    echo "分支状态:"
    if git show-ref --verify --quiet "refs/heads/${lm_branch}"; then
        echo "  本地: 存在"
    else
        echo "  本地: 不存在"
    fi

    local remotes_json
    remotes_json=$(json_get "$config_path" "remotes")
    while IFS= read -r remote; do
        remote=$(echo "$remote" | tr -d '"' | xargs)
        if [[ -n "$remote" ]]; then
            if git show-ref --verify --quiet "refs/remotes/${remote}/${lm_branch}"; then
                echo "  ${remote}: 存在"
            else
                echo "  ${remote}: 不存在"
            fi
        fi
    done < <(echo "$remotes_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for item in data:
    print(item)
")
}

cmd_push() {
    local project_name="${1:-$(get_project_name)}"
    local config_path
    local lm_branch
    local remotes_json

    config_path=$(get_config_path "$project_name")
    lm_branch=$(json_get "$config_path" "lightmerge_branch_name")
    remotes_json=$(json_get "$config_path" "remotes")

    if ! git show-ref --verify --quiet "refs/heads/${lm_branch}"; then
        echo "错误: 本地不存在 ${lm_branch} 分支，请先 rebuild" >&2
        exit 1
    fi

    while IFS= read -r remote; do
        remote=$(echo "$remote" | tr -d '"' | xargs)
        if [[ -n "$remote" ]]; then
            echo "推送到 ${remote}/${lm_branch}..."
            git push -u "${remote}" "${lm_branch}" && echo "成功" || echo "失败"
        fi
    done < <(echo "$remotes_json" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
for item in data:
    print(item)
")
}

# ─── 重建状态管理（用于冲突暂停/恢复）──────────────────

_write_rebuild_state() {
    local project_name="$1" base_branch="$2" lm_branch="$3" original_branch="$4"
    local remotes_csv="$5" branches_csv="$6" next_index="$7" conflict_branch="$8"
    local mode="${9:-full}"

    local state_dir="${CONFIG_BASE_DIR}/${project_name}"
    local state_path="${state_dir}/.rebuild-state.json"
    mkdir -p "$state_dir"

    # 用临时文件传递数据，避免 shell 变量注入 Python 代码
    local tmpfile
    tmpfile=$(mktemp)
    local cleanup_tmp=true
    trap 'rm -f "$tmpfile" "$tmpfile.remotes" "$tmpfile.branches"' RETURN
    printf '%s\n' "$remotes_csv" > "$tmpfile.remotes"
    printf '%s\n' "$branches_csv" > "$tmpfile.branches"

    if [[ "$mode" == "full" ]]; then
        python3 - "$state_path" "$project_name" "$base_branch" "$lm_branch" "$original_branch" "$next_index" "$conflict_branch" "$tmpfile" << 'PYEOF'
import json, sys
state_path, project_name, base_branch, lm_branch = sys.argv[1:5]
original_branch, next_index, conflict_branch, tmpfile = sys.argv[5:9]
with open(tmpfile + ".remotes") as f:
    remotes = [l.strip() for l in f if l.strip()]
with open(tmpfile + ".branches") as f:
    branches = [l.strip() for l in f if l.strip()]
state = {
    'project_name': project_name,
    'base_branch': base_branch,
    'lm_branch': lm_branch,
    'original_branch': original_branch,
    'remotes': remotes,
    'branches': branches,
    'next_index': int(next_index),
    'conflict_branch': conflict_branch
}
with open(state_path, 'w') as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
PYEOF
    else
        python3 - "$state_path" "$next_index" "$conflict_branch" << 'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    state = json.load(f)
state['next_index'] = int(sys.argv[2])
state['conflict_branch'] = sys.argv[3]
with open(sys.argv[1], 'w') as f:
    json.dump(state, f, indent=2, ensure_ascii=False)
PYEOF
    fi
}

_read_rebuild_state() {
    local project_name="${1:-$(get_project_name)}"
    STATE_FILE="${CONFIG_BASE_DIR}/${project_name}/.rebuild-state.json"

    if [[ ! -f "$STATE_FILE" ]]; then
        echo "错误: 没有进行中的重建任务（状态文件不存在）" >&2
        exit 1
    fi

    cat "$STATE_FILE"
}

_clear_rebuild_state() {
    if [[ -n "$STATE_FILE" ]] && [[ -f "$STATE_FILE" ]]; then
        rm -f "$STATE_FILE"
    fi
}

# 合并循环（从 next_index 开始逐个合并）
_do_merge_loop() {
    local project_name="$1"
    local lm_branch="$2"
    local start_index="$3"
    local state_path="${CONFIG_BASE_DIR}/${project_name}/.rebuild-state.json"

    local state
    state=$(cat "$state_path")

    local branches remotes original_branch
    branches=$(echo "$state" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(b) for b in d['branches']]")
    remotes=$(echo "$state" | python3 -c "import json,sys; d=json.load(sys.stdin); [print(r) for r in d['remotes']]")
    original_branch=$(echo "$state" | python3 -c "import json,sys; print(json.load(sys.stdin)['original_branch'])")

    local branches_arr=()
    while IFS= read -r line; do
        [[ -n "$line" ]] && branches_arr+=("$line")
    done <<< "$branches"

    local remotes_arr=()
    while IFS= read -r line; do
        [[ -n "$line" ]] && remotes_arr+=("$line")
    done <<< "$remotes"

    local total=${#branches_arr[@]}
    local success_count=0
    local fail_count=0
    local failed_branches=()

    # 计算之前已成功的数量（start_index 就是之前已完成的数量）
    success_count=$start_index

    for ((i=start_index; i<total; i++)); do
        local branch="${branches_arr[$i]}"
        echo ""
        echo "[$((i+1))/${total}] 合并 ${branch}..."

        # 检查分支是否存在（本地或配置的任一远端）
        local branch_found=false
        if git show-ref --verify --quiet "refs/heads/${branch}" 2>/dev/null; then
            branch_found=true
        else
            for remote in "${remotes_arr[@]}"; do
                if git show-ref --verify --quiet "refs/remotes/${remote}/${branch}" 2>/dev/null; then
                    branch_found=true
                    break
                fi
            done
        fi
        if [[ "$branch_found" == false ]]; then
            echo "  警告: 分支 ${branch} 不存在，跳过"
            failed_branches+=("${branch} (不存在)")
            fail_count=$((fail_count + 1))
            continue
        fi

        # 合并（不自动提交，以便检查冲突）
        if git merge --no-commit "${branch}"; then
            if ! git commit -m "lightmerge: 合并 ${branch}" 2>&1; then
                echo "  失败: commit 被拒绝（可能是 pre-commit hook 错误）"
                git merge --abort 2>/dev/null || true
                failed_branches+=("${branch} (commit 失败)")
                fail_count=$((fail_count + 1))
                continue
            fi
            echo "  成功"
            success_count=$((success_count + 1))
            # 更新状态文件中的 next_index
            _write_rebuild_state "$project_name" "" "" "" "" "" "$((i+1))" "" "update"
        else
            # 有冲突 — 暂停，不 abort
            local conflict_files
            conflict_files=$(git diff --name-only --diff-filter=U 2>/dev/null || true)

            # 构建剩余分支列表
            local remaining=()
            for ((j=i+1; j<total; j++)); do
                remaining+=("${branches_arr[$j]}")
            done

            echo ""
            echo "=== CONFLICT DETECTED ==="
            echo "CONFLICT_BRANCH: ${branch}"
            echo "CONFLICT_FILES:"
            echo "$conflict_files" | sed 's/^/  /'
            echo "REMAINING_BRANCHES:"
            for rb in "${remaining[@]}"; do
                echo "  ${rb}"
            done
            echo "ORIGINAL_BRANCH: ${original_branch}"
            echo "============================"
            echo ""
            echo "合并已暂停。请解决冲突后执行 continue，或执行 abort 放弃重建。"

            # 更新状态：记录冲突分支
            _write_rebuild_state "$project_name" "" "" "" "" "" "$i" "$branch" "update"

            # 退出码 10 表示冲突暂停
            exit 10
        fi
    done

    echo ""
    echo "=== 合并完成 ==="
    echo "成功: ${success_count} 个"
    echo "失败/跳过: ${fail_count} 个"
    if [[ ${#failed_branches[@]} -gt 0 ]]; then
        echo "失败分支:"
        for fb in "${failed_branches[@]}"; do
            echo "  - ${fb}"
        done
    fi

    # 推送到所有 remote
    if [[ ${success_count} -gt 0 ]]; then
        for remote in "${remotes_arr[@]}"; do
            echo ""
            echo "推送到 ${remote}/${lm_branch}..."
            if ! git push -u "${remote}" "${lm_branch}"; then
                echo "  推送失败！请检查网络或权限"
            fi
        done
    fi

    # 切回之前的分支
    if [[ -n "$original_branch" ]] && [[ "$original_branch" != "$lm_branch" ]]; then
        echo ""
        echo "切回原分支: ${original_branch}"
        if ! git checkout "$original_branch" 2>/dev/null; then
            echo "  警告: 无法切回 ${original_branch}（可能有未提交的修改），当前仍在 ${lm_branch}"
        fi
    fi

    # 清理状态文件
    _clear_rebuild_state

    echo ""
    echo "=== lightmerge 完成 ==="
}

# ─── 冲突恢复命令 ─────────────────────────────────────────

cmd_continue() {
    local project_name="${1:-$(get_project_name)}"
    local state_path="${CONFIG_BASE_DIR}/${project_name}/.rebuild-state.json"

    if [[ ! -f "$state_path" ]]; then
        echo "错误: 没有进行中的重建任务" >&2
        exit 1
    fi

    local state
    state=$(cat "$state_path")

    local conflict_branch lm_branch
    conflict_branch=$(echo "$state" | python3 -c "import json,sys; print(json.load(sys.stdin)['conflict_branch'])")
    lm_branch=$(echo "$state" | python3 -c "import json,sys; print(json.load(sys.stdin)['lm_branch'])")

    # 验证当前确实在 lightmerge 分支上
    local current_branch
    current_branch=$(git branch --show-current)
    if [[ "$current_branch" != "$lm_branch" ]]; then
        echo "错误: 当前分支是 ${current_branch}，不是 ${lm_branch}" >&2
        echo "请先切换到 ${lm_branch} 分支" >&2
        exit 1
    fi

    # 检查是否还有未解决的冲突
    if git diff --name-only --diff-filter=U | grep -q .; then
        echo "错误: 仍有未解决的冲突文件：" >&2
        git diff --name-only --diff-filter=U | sed 's/^/  /' >&2
        echo "请先解决所有冲突并 git add 后再执行 continue" >&2
        exit 1
    fi

    # 检查是否有已解决但未提交的文件（git add 过的）
    if ! git diff --cached --quiet 2>/dev/null; then
        echo "提交冲突解决: lightmerge: 解决 ${conflict_branch} 的合并冲突"
        git commit -m "lightmerge: 解决 ${conflict_branch} 的合并冲突"
        echo "  冲突解决已提交"
    fi

    # 读取 next_index（冲突分支的索引，需要 +1 跳过它）
    local next_index
    next_index=$(echo "$state" | python3 -c "import json,sys; print(json.load(sys.stdin)['next_index'])")

    # 从下一个分支继续合并
    _do_merge_loop "$project_name" "$lm_branch" "$((next_index + 1))"
}

cmd_abort() {
    local project_name="${1:-$(get_project_name)}"
    local state_path="${CONFIG_BASE_DIR}/${project_name}/.rebuild-state.json"

    if [[ ! -f "$state_path" ]]; then
        echo "错误: 没有进行中的重建任务" >&2
        exit 1
    fi

    local state
    state=$(cat "$state_path")

    local original_branch lm_branch
    original_branch=$(echo "$state" | python3 -c "import json,sys; print(json.load(sys.stdin)['original_branch'])")
    lm_branch=$(echo "$state" | python3 -c "import json,sys; print(json.load(sys.stdin)['lm_branch'])")

    echo "中止重建..."

    # 中止当前的 merge（如果有的话）
    git merge --abort 2>/dev/null || true

    # 先切离当前分支（如果恰好在 lightmerge 分支上）
    local current_branch
    current_branch=$(git branch --show-current)

    if [[ "$current_branch" == "$lm_branch" ]]; then
        if [[ -n "$original_branch" ]] && git show-ref --verify --quiet "refs/heads/${original_branch}"; then
            git checkout "$original_branch" 2>/dev/null || true
        else
            # original_branch 无效，创建临时分支以脱离 lightmerge
            git checkout --detach HEAD 2>/dev/null || true
            echo "警告: 无法切回原分支 ${original_branch}，已切换到 detached HEAD"
        fi
    fi

    # 删除 lightmerge 分支
    if git show-ref --verify --quiet "refs/heads/${lm_branch}"; then
        git branch -D "$lm_branch" 2>/dev/null || true
    fi

    # 清理状态文件
    _clear_rebuild_state

    echo "重建已中止，lightmerge 分支已删除"
}

# ─── 主入口 ──────────────────────────────────────────────

usage() {
    echo "用法: lightmerge.sh <command> [args]"
    echo ""
    echo "命令:"
    echo "  init [project-name] [base-branch] [remote] [branch-name]  初始化配置"
    echo "  add <project-name> <branch>                 添加分支并重建"
    echo "  remove <project-name> <branch>              移除分支并重建"
    echo "  rebuild [project-name]                      重建 lightmerge 分支"
    echo "  continue [project-name]                     冲突解决后继续合并"
    echo "  abort [project-name]                        中止当前重建并切回原分支"
    echo "  list [project-name]                         查看当前配置"
    echo "  push [project-name]                         手动推送到远端"
    echo ""
    echo "默认 project-name 为当前 git 仓库目录名。"
}

main() {
    local command="${1:-}"
    shift || true

    case "$command" in
        init)
            cmd_init "$@"
            ;;
        add)
            cmd_add "$@"
            ;;
        remove)
            cmd_remove "$@"
            ;;
        rebuild)
            cmd_rebuild "$@"
            ;;
        continue|resume)
            cmd_continue "$@"
            ;;
        abort)
            cmd_abort "$@"
            ;;
        list|"")
            cmd_list "$@"
            ;;
        push)
            cmd_push "$@"
            ;;
        -h|--help|help)
            usage
            ;;
        *)
            echo "未知命令: ${command}" >&2
            usage
            exit 1
            ;;
    esac
}

main "$@"
