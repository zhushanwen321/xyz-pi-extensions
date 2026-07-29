#!/usr/bin/env bash
# pr-submit.sh — push + 创建/更新 PR 一体化
#
# 等价于 .agents/skills/pull-request/SKILL.md Step 4。
# 自动检测 PR 是否已存在、仅在 title/body 有变化时更新。
#
# 用法:
#   bash scripts/pr-submit.sh --title-file <path> --body-file <path>
#   bash scripts/pr-submit.sh --title "feat: x" --body "..."            # 直接传字符串
#   bash scripts/pr-submit.sh --base main --dry-run                     # 不真 push 也不 create
#   bash scripts/pr-submit.sh --review-report <aggregated.md path>       # 自动附到 body 末尾
#
# 退出码:
#   0 = 成功（push + pr create/edit 完成）
#   1 = 入参错误
#   2 = git push 失败
#   3 = gh 调用失败（已认证但调用失败）
#   4 = PR 不存在且 --update-only 被设置
#   5 = title/body 文件缺失或不可读

set -euo pipefail

TITLE=""
BODY_FILE=""
TITLE_FILE=""
BASE="main"
DRY_RUN=0
UPDATE_ONLY=0
REVIEW_REPORT=""

usage() {
    sed -n '2,12p' "$0" | sed 's/^# \?//'
    exit 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --title)         TITLE="$2"; shift 2 ;;
        --title-file)    TITLE_FILE="$2"; shift 2 ;;
        --body-file)     BODY_FILE="$2"; shift 2 ;;
        --base)          BASE="$2"; shift 2 ;;
        --dry-run)       DRY_RUN=1; shift ;;
        --update-only)   UPDATE_ONLY=1; shift ;;
        --review-report) REVIEW_REPORT="$2"; shift 2 ;;
        -h|--help)       usage ;;
        *)               echo "Unknown arg: $1" >&2; usage ;;
    esac
done

GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 2; })"
cd "$GIT_ROOT"

BRANCH="$(git branch --show-current)"
[[ -z "$BRANCH" ]] && { echo "Cannot determine current branch" >&2; exit 2; }
[[ "$BRANCH" == "$BASE" ]] && { echo "Current branch is $BASE; refusing to push" >&2; exit 2; }

# ── 解析 title/body
if [[ -n "$TITLE_FILE" ]]; then
    [[ -r "$TITLE_FILE" ]] || { echo "Title file not readable: $TITLE_FILE" >&2; exit 5; }
    TITLE="$(cat "$TITLE_FILE")"
fi
if [[ -z "$TITLE" ]]; then
    # 默认：取最新 commit subject 加 conventional commit 前缀规范
    TITLE="$(git log -1 --format='%s')"
fi
[[ -n "$BODY_FILE" ]] || BODY_FILE="$(mktemp -t pr-body.XXXXXX)"
[[ -r "$BODY_FILE" ]] || { echo "Body file not readable: $BODY_FILE" >&2; exit 5; }

# ── 若 --review-report 提供，把它的内容 append 到 body 末尾
if [[ -n "$REVIEW_REPORT" && -r "$REVIEW_REPORT" ]]; then
    REVIEW_SECTION="$(mktemp -t pr-review.XXXXXX)"
    {
        echo ""
        echo "## Review Summary"
        echo ""
        echo "Aggregated review across 5 dimensions (business-logic / monorepo-impact / type-safety / extension-api / test-coverage):"
        echo ""
        # 只抓 Summary 段，避免污染（其余表格留给 reviewer 直接看 PR conversation）
        awk '/^## Summary/,/^## [^S]/' "$REVIEW_REPORT" \
            | sed '/^## [^S]/d' \
            > "$REVIEW_SECTION"
        cat "$REVIEW_SECTION"
    } >> "$BODY_FILE"
    rm -f "$REVIEW_SECTION"
fi

log() { echo "[pr-submit] $*" >&2; }

# ── 1. push（force-with-lease 安全推送，禁止 --force）
log "pushing $BRANCH to origin..."
if [[ "$DRY_RUN" == "1" ]]; then
    log "(dry-run) skip push"
else
    if ! git push origin "HEAD" --force-with-lease; then
        log "git push failed; check upstream tracking" >&2
        exit 2
    fi
fi

# ── 2. 探测现有 PR
log "checking existing PR for branch $BRANCH..."
EXISTING_JSON="$(gh pr list --head "$BRANCH" --base "$BASE" --state open --json number,title,body 2>/dev/null || echo '[]')"

PR_NUMBER=""
EXISTING_TITLE=""
EXISTING_BODY=""
if [[ "$EXISTING_JSON" != "[]" && -n "$EXISTING_JSON" ]]; then
    PR_NUMBER=$(echo "$EXISTING_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['number'] if d else '')")
    EXISTING_TITLE=$(echo "$EXISTING_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['title'] if d else '')")
    EXISTING_BODY=$(echo "$EXISTING_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['body'] if d else '')")
fi

NEW_BODY="$(cat "$BODY_FILE")"

# ── 3. create / edit 分支
if [[ -z "$PR_NUMBER" ]]; then
    if [[ "$UPDATE_ONLY" == "1" ]]; then
        log "no existing PR for $BRANCH and --update-only set; aborting" >&2
        exit 4
    fi

    log "creating new PR..."
    if [[ "$DRY_RUN" == "1" ]]; then
        log "(dry-run) gh pr create --base $BASE --title <title> --body-file $BODY_FILE"
        echo "https://github.com/dry-run/pr/create"
    else
        PR_URL="$(gh pr create --base "$BASE" --title "$TITLE" --body-file "$BODY_FILE")"
        log "created: $PR_URL"
        echo "$PR_URL"
    fi
else
    log "updating existing PR #$PR_NUMBER..."
    NEEDS_TITLE="false"
    NEEDS_BODY="false"

    # 简单 diff：字符串完全相等才不更新
    [[ "$TITLE" != "$EXISTING_TITLE" ]] && NEEDS_TITLE="true"
    [[ "$NEW_BODY" != "$EXISTING_BODY" ]] && NEEDS_BODY="true"

    if [[ "$DRY_RUN" == "1" ]]; then
        log "(dry-run) needs title=$NEEDS_TITLE body=$NEEDS_BODY"
        log "(dry-run) gh pr edit $PR_NUMBER [--title --body]"
        echo "https://github.com/dry-run/pr/$PR_NUMBER"
    else
        if [[ "$NEEDS_TITLE" == "true" || "$NEEDS_BODY" == "true" ]]; then
            EDIT_ARGS=( "$PR_NUMBER" )
            [[ "$NEEDS_TITLE" == "true" ]] && EDIT_ARGS+=( --title "$TITLE" )
            [[ "$NEEDS_BODY" == "true" ]]  && EDIT_ARGS+=( --body-file "$BODY_FILE" )
            gh pr edit "${EDIT_ARGS[@]}" || { log "gh pr edit failed" >&2; exit 3; }
            log "updated PR #$PR_NUMBER (title=$NEEDS_TITLE body=$NEEDS_BODY)"
        else
            log "PR #$PR_NUMBER already up to date; no edit needed"
        fi
        PR_URL="$(gh pr view "$PR_NUMBER" --json url -q .url)"
        log "PR URL: $PR_URL"
        echo "$PR_URL"
    fi
fi
