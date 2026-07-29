#!/usr/bin/env bash
# pr-status.test.sh — 集成测试 scripts/pr-status.sh 的 ready_to_submit 公式
#
# 背景（S8）: ready_to_submit 公式刚做了核心逻辑变更（移除 stage1.clean 硬条件），
# 此前无测试覆盖。本文件构造 mock 状态组合，断言 ready 在正确组合为 true、其余为 false。
#
# 新公式（见 pr-status.sh）:
#   ready = stage0.pr_exists && stage0.local_ahead_of_origin == 0 && stage2.result == "PASS"
#   stage1.clean 已退出 ready 公式（保留诊断字段），本测试也验证 clean 不再 gate ready。
#
# 策略:
#   - 用真实临时 git 仓库（git 调用不 mock，更稳定；通过 update-ref 控制 origin/<branch> 位置）
#   - 仅通过 PATH 注入 mock gh（返回固定 PR JSON 或空数组）
#   - 构造 .review/ 目录与 premerge-result marker
#   - 直接调用 scripts/pr-status.sh，解析 JSON 的 ready_to_submit 字段断言
#
# 运行: bash scripts/pr-status.test.sh
# 退出码: 0=全过, 非 0=有失败

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBJECT="$SCRIPT_DIR/pr-status.sh"

PASS=0
FAIL=0
WORK_ROOT=""

cleanup() {
    [[ -n "$WORK_ROOT" && -d "$WORK_ROOT" ]] && rm -rf "$WORK_ROOT"
}
trap cleanup EXIT

# fail <name> <msg>
fail() {
    echo "FAIL: $1 — $2"
    FAIL=$((FAIL + 1))
}
ok() {
    echo "ok   — $1"
    PASS=$((PASS + 1))
}

# 写 marker 文件到给定 review 目录
# write_marker <review_dir> <result> [stale: STALE 标志会把 mtime 改到 31 分钟前]
write_marker() {
    local rdir="$1" result="$2"
    mkdir -p "$rdir"
    local marker="$rdir/premerge-result"
    if [[ "$result" == "not_run" ]]; then
        rm -f "$marker"
        return
    fi
    cat >"$marker" <<EOF
timestamp="2026-01-01T00:00:00Z"
result="$result"
EOF
    if [[ "${3:-}" == "STALE" ]]; then
        # 把 mtime 推到 31 分钟前，触发脚本里的 30 分钟 stale 逻辑。
        # 用 -t [[CC]YY]MMDDhhmm —— BSD touch (macOS) 与 GNU touch 均支持；
        # -d 在 BSD touch 上不生效（实测），故不用。
        # 优先 GNU date -d，失败则用 BSD date -v。
        local ts
        ts="$(date -d '-31 minutes' '+%Y%m%d%H%M' 2>/dev/null || date -v-31M '+%Y%m%d%H%M' 2>/dev/null || true)"
        [[ -n "$ts" ]] && touch -t "$ts" "$marker" 2>/dev/null || true
    fi
}

# 在临时 repo 跑一次 pr-status.sh，取 ready_to_submit + 关键诊断字段（JSON）
# run_status <gh_mode: pr|none> <local_ahead: 0|1> <premerge: PASS|FAIL|not_run|STALE> <clean_must_fix: 0|N>
# 输出: "ready=<bool> pr_exists=<bool> ahead=<int> pm=<str> clean=<bool>"
run_status() {
    local gh_mode="$1" ahead="$2" premerge="$3" clean_must_fix="${4:-0}"

    local repo="$WORK_ROOT/repo"
    local rdir="$repo/.review"

    # 重置 repo 状态：基于 main 建 feat 分支
    git -C "$repo" checkout -q feat 2>/dev/null || git -C "$repo" checkout -q -b feat
    # 控制 origin/feat 位置 → 决定 local_ahead
    if [[ "$ahead" == "0" ]]; then
        git -C "$repo" update-ref refs/remotes/origin/feat HEAD
    else
        # ahead=1: origin/feat 落后 HEAD 一个 commit
        git -C "$repo" update-ref refs/remotes/origin/feat HEAD~1
    fi

    # premerge marker
    case "$premerge" in
        PASS)    write_marker "$rdir" PASS ;;
        FAIL)    write_marker "$rdir" FAIL ;;
        STALE)   write_marker "$rdir" PASS STALE ;;
        not_run) write_marker "$rdir" not_run ;;
    esac

    # stage1 aggregated.md：构造 must_fix 数（验证 clean 不再 gate ready）
    local agg="$rdir/run-1/round-1/aggregated.md"
    mkdir -p "$(dirname "$agg")"
    cat >"$agg" <<EOF
# Run 1 Round 1

## Summary

- Must-fix: $clean_must_fix
- Suggestions: 0
- Infos: 0
EOF

    # gh mock 通过 PATH 注入
    local bin="$WORK_ROOT/bin"
    mkdir -p "$bin"
    if [[ "$gh_mode" == "pr" ]]; then
        cat >"$bin/gh" <<'EOF'
#!/usr/bin/env bash
echo '[{"number":42,"url":"https://x.example/pr/42","state":"OPEN"}]'
EOF
    else
        cat >"$bin/gh" <<'EOF'
#!/usr/bin/env bash
echo '[]'
EOF
    fi
    chmod +x "$bin/gh"

    local out
    out="$(cd "$repo" && PATH="$bin:$PATH" bash "$SUBJECT" --review-dir .review 2>/dev/null)"

    # 解析（尽量不依赖 jq；有 jq 则用，否则退化用 grep）
    local ready pr_exists local_ahead pm clean
    if command -v jq >/dev/null 2>&1; then
        ready="$(printf '%s' "$out" | jq -r '.ready_to_submit')"
        pr_exists="$(printf '%s' "$out" | jq -r '.stage0_pr.pr_exists')"
        local_ahead="$(printf '%s' "$out" | jq -r '.stage0_pr.local_ahead_of_origin')"
        pm="$(printf '%s' "$out" | jq -r '.stage2_premerge.result')"
        clean="$(printf '%s' "$out" | jq -r '.stage1_review.clean')"
    else
        ready="$(printf '%s' "$out" | grep -o '"ready_to_submit": [a-z]*' | head -1 | sed 's/.*: //')"
        pr_exists="$(printf '%s' "$out" | grep -o '"pr_exists": [a-z]*' | head -1 | sed 's/.*: //')"
        local_ahead="$(printf '%s' "$out" | grep -o '"local_ahead_of_origin": [0-9]*' | head -1 | sed 's/.*: //')"
        pm="$(printf '%s' "$out" | grep -o '"result": "[a-z_]*"' | head -1 | sed 's/.*: "\(.*\)"/\1/')"
        clean="$(printf '%s' "$out" | grep -o '"clean": [a-z]*' | head -1 | sed 's/.*: //')"
    fi
    echo "ready=$ready pr_exists=$pr_exists ahead=$local_ahead pm=$pm clean=$clean"
}

# 断言 helper: assert <label> <got> <want> <state-line>
assert_eq() {
    local label="$1" got="$2" want="$3" line="$4"
    if [[ "$got" == "$want" ]]; then
        ok "$label (got=$got) [$line]"
    else
        fail "$label" "expected [$want], got [$got] — $line"
    fi
}

main() {
    WORK_ROOT="$(mktemp -d)"
    local repo="$WORK_ROOT/repo"
    git init -q "$repo"
    git -C "$repo" config user.email t@t.com
    git -C "$repo" config user.name t
    git -C "$repo" branch -m main 2>/dev/null || git -C "$repo" checkout -q -b main
    git -C "$repo" commit -q --allow-empty -m init
    git -C "$repo" commit -q --allow-empty -m "second commit"   # 让 HEAD~1 存在（ahead=1 用得到）

    echo "## ready_to_submit 真值表（新公式）"
    echo

    # 表格：pr_exists | local_ahead | premerge | clean_must_fix | expected ready
    # 行 1: 全绿 → ready=true
    s="$(run_status pr 0 PASS 0)"
    assert_eq "pr=T ahead=0 pm=PASS clean=T → ready=true" \
        "$(printf '%s' "$s" | sed 's/.*ready=\([a-z]*\).*/\1/')" "true" "$s"

    # 行 2: premerge FAIL → ready=false
    s="$(run_status pr 0 FAIL 0)"
    assert_eq "pr=T ahead=0 pm=FAIL → ready=false" \
        "$(printf '%s' "$s" | sed 's/.*ready=\([a-z]*\).*/\1/')" "false" "$s"

    # 行 3: premerge not_run → ready=false
    s="$(run_status pr 0 not_run 0)"
    assert_eq "pr=T ahead=0 pm=not_run → ready=false" \
        "$(printf '%s' "$s" | sed 's/.*ready=\([a-z]*\).*/\1/')" "false" "$s"

    # 行 4: local_ahead=1 → ready=false
    s="$(run_status pr 1 PASS 0)"
    assert_eq "pr=T ahead=1 pm=PASS → ready=false" \
        "$(printf '%s' "$s" | sed 's/.*ready=\([a-z]*\).*/\1/')" "false" "$s"

    # 行 5: pr_exists=false → ready=false
    s="$(run_status none 0 PASS 0)"
    assert_eq "pr=F ahead=0 pm=PASS → ready=false" \
        "$(printf '%s' "$s" | sed 's/.*ready=\([a-z]*\).*/\1/')" "false" "$s"

    echo
    echo "## 关键回归：stage1.clean 不再 gate ready（S8 核心变更）"
    echo

    # clean=false（must_fix=3）但其余全绿 → ready 仍应为 true（这是本次变更的正确语义）
    s="$(run_status pr 0 PASS 3)"
    assert_eq "pr=T ahead=0 pm=PASS clean=F(must_fix=3) → ready=true（clean 不再 gate）" \
        "$(printf '%s' "$s" | sed 's/.*ready=\([a-z]*\).*/\1/')" "true" "$s"
    # 同时确认 clean 字段确实被读为 false（防止未来回退成“clean 永远 true”的 bug）
    assert_eq "  辅助：clean 字段被正确解析为 false" \
        "$(printf '%s' "$s" | sed 's/.*clean=\([a-z]*\).*/\1/')" "false" "$s"

    echo
    echo "## premerge PASS 但 stale（>30min）→ 不算 PASS → ready=false"
    s="$(run_status pr 0 STALE 0)"
    assert_eq "pr=T ahead=0 pm=STALE → ready=false（PASS 过期变 STALE）" \
        "$(printf '%s' "$s" | sed 's/.*ready=\([a-z]*\).*/\1/')" "false" "$s"

    echo
    echo "## 结果：$PASS passed, $FAIL failed"
    if [[ "$FAIL" -gt 0 ]]; then
        exit 1
    fi
}

main "$@"
