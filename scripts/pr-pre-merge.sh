#!/usr/bin/env bash
# pr-pre-merge.sh — pre-merge 工程验证一体化
#
# 按顺序执行 typecheck → lint → test → build，任意一步失败立即退出。
# 等价于 .agents/skills/pull-request/SKILL.md Step 1 的 4 条 pnpm -r 命令。
# 与 .githooks/pre-commit 对齐（tsc + eslint + vitest）。
#
# 用法:
#   bash scripts/pr-pre-merge.sh
#   bash scripts/pr-pre-merge.sh --quiet   # 只输出最终结果
#
# 退出码:
#   0 = 全部通过
#   1 = 任意一步失败（输出失败步骤的 stderr 末 30 行）
#
# 环境变量:
#   PR_PRE_MERGE_SKIP_BUILD=1   跳过 build 步骤（可选 build 不是所有包都有）
#   PR_PRE_MERGE_QUIET=1        静默模式（只在结束时输出汇总）

set -euo pipefail

QUIET="${PR_PRE_MERGE_QUIET:-0}"
[[ "${1:-}" == "--quiet" ]] && QUIET=1

log() {
    [[ "$QUIET" == "1" ]] || echo "[pr-pre-merge] $*"
}

# 必须在 git 仓库根目录
GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 2; })"
cd "$GIT_ROOT"

START=$(date +%s)
RESULTS=()

run_step() {
    local name="$1"; shift
    local cmd="$*"
    log "▸ Step: $name"
    local step_start=$(date +%s)
    local exit_code=0
    local output_file
    output_file="$(mktemp -t pr-pre-merge.XXXXXX)"

    # 同时捕获 stdout+stderr；只对命令本身静默
    if [[ "$QUIET" == "1" ]]; then
        "$@" >"$output_file" 2>&1 || exit_code=$?
    else
        "$@" 2>&1 | tee "$output_file"
        exit_code=${PIPESTATUS[0]}
    fi

    local step_end=$(date +%s)
    local elapsed=$((step_end - step_start))

    if [[ $exit_code -eq 0 ]]; then
        RESULTS+=("PASS $name ${elapsed}s")
        log "  ✓ $name passed in ${elapsed}s"
        rm -f "$output_file"
    else
        RESULTS+=("FAIL $name ${elapsed}s (exit=$exit_code)")
        log "  ✗ $name failed in ${elapsed}s (exit=$exit_code)"
        log "  --- last 30 lines of output ---"
        tail -30 "$output_file" >&2 || true
        log "  -------------------------------"
        rm -f "$output_file"
        return $exit_code
    fi
}

# ── Step 1: typecheck（高耗时/错误最容易暴露，先跑）
run_step "typecheck" pnpm -r typecheck

# ── Step 2: lint
run_step "lint" pnpm -r lint

# ── Step 3: test
run_step "test" pnpm -r test

# ── Step 4: build（可选，跳过若 PR_PRE_MERGE_SKIP_BUILD=1 或无 build script）
if [[ "${PR_PRE_MERGE_SKIP_BUILD:-0}" == "1" ]]; then
    log "  ↷ build skipped (PR_PRE_MERGE_SKIP_BUILD=1)"
    RESULTS+=("SKIP build 0s")
else
    # --if-present 容忍单包无 build script；2>/dev/null 把所有包的 NOTICE/ERR 收掉
    # 但我们保留 set -e 仍要捕获真实 build 错误 → 用 || true 检测整体失败不准确，
    # 改用 grep 探针：若 pnpm 输出 "ERR_PNPM_NO_SCRIPT" 才认为是没有 build 而不是失败
    build_output="$(mktemp -t pr-pre-merge-build.XXXXXX)"
    if pnpm -r build --if-present >"$build_output" 2>&1; then
        build_exit=0
    else
        build_exit=$?
    fi

    # pnpm 在 --if-present 下，单包没有 build script 不算失败（exit 0），
    # 全无时 exit 1 并打印 "ERR_PNPM_NO_SCRIPT" 也视为无构建需求。
    if [[ $build_exit -eq 0 ]] || grep -q "ERR_PNPM_NO_SCRIPT\|No script found" "$build_output"; then
        RESULTS+=("PASS build 0s (no-op)")
        log "  ✓ build passed (no-op)"
        rm -f "$build_output"
    else
        RESULTS+=("FAIL build (exit=$build_exit)")
        log "  ✗ build failed (exit=$build_exit)"
        tail -30 "$build_output" >&2 || true
        rm -f "$build_output"
        # 失败时标记 STALE 让 pr-status.sh 知道这不是 PASS
        mkdir -p .review
        TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
        cat > .review/premerge-result <<MARKER
timestamp="$TS"
result="FAIL"
MARKER
        exit "$build_exit"
    fi
fi

END=$(date +%s)
TOTAL=$((END - START))

echo ""
echo "[pr-pre-merge] === SUMMARY (${TOTAL}s total) ==="
for r in "${RESULTS[@]}"; do
    echo "  $r"
done
echo "[pr-pre-merge] all checks passed ✓"

# ── 写入 stage gate marker（供 pr-status.sh 读取）
mkdir -p .review
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > .review/premerge-result <<MARKER
timestamp="$TS"
result="PASS"
MARKER

exit 0
