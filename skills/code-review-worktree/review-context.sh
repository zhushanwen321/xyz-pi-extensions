#!/usr/bin/env bash
# review-context.sh — 收集 worktree 代码审查所需的上下文
# 用法: bash review-context.sh [--against main] [--staged] [--path <dir>]
set -euo pipefail

AGAINST="main"
STAGED=""
PATH_FILTER=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --against) AGAINST="$2"; shift 2 ;;
    --staged)  STAGED="1"; shift ;;
    --path)    PATH_FILTER="$2"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || { echo "Not a git repo" >&2; exit 1; })

# --- 1. 变更文件和行数统计（locale-independent: --numstat 输出纯数字） ---
if [[ -n "$STAGED" ]]; then
  DIFF_NUMSTAT=$(git diff --cached --numstat ${PATH_FILTER:+-- "$PATH_FILTER"})
  DIFF_FILES=$(git diff --cached --name-only ${PATH_FILTER:+-- "$PATH_FILTER"})
else
  DIFF_NUMSTAT=$(git diff "${AGAINST}...HEAD" --numstat ${PATH_FILTER:+-- "$PATH_FILTER"})
  DIFF_FILES=$(git diff "${AGAINST}...HEAD" --name-only ${PATH_FILTER:+-- "$PATH_FILTER"})
fi

TOTAL_FILES=$(echo "$DIFF_FILES" | grep -c . || true)
if [[ "$TOTAL_FILES" -eq 0 ]]; then
  echo '{"harness_mode":"none","dimensions":[],"effort":"simple","total_files":0}'
  exit 0
fi

# --numstat: each line = "added\tdeleted\tfilename"
INSERTIONS=$(echo "$DIFF_NUMSTAT" | awk '{s+=$1} END {print s+0}')
DELETIONS=$(echo "$DIFF_NUMSTAT" | awk '{s+=$2} END {print s+0}')

# --- 2. 模式检测 ---
HARNESS_MODE="standalone"
HARNESS_DIR=""
if [[ -d "${GIT_ROOT}/.xyz-harness" ]]; then
  TOPIC_DIR=$(find "${GIT_ROOT}/.xyz-harness" -maxdepth 2 -name "spec.md" -exec dirname {} \; 2>/dev/null | sort -r | head -1 || true)
  if [[ -n "$TOPIC_DIR" && -f "${TOPIC_DIR}/spec.md" && -f "${TOPIC_DIR}/plan.md" ]]; then
    HARNESS_MODE="harness"
    HARNESS_DIR="$TOPIC_DIR"
  fi
fi

# --- 3. 语言检测（优先级: ts > rust > python） ---
PRIMARY_LANG="unknown"
if echo "$DIFF_FILES" | grep -qE '\.(ts|tsx|vue|svelte)$'; then
  PRIMARY_LANG="ts"
elif echo "$DIFF_FILES" | grep -qE '\.rs$'; then
  PRIMARY_LANG="rust"
elif echo "$DIFF_FILES" | grep -qE '\.py$'; then
  PRIMARY_LANG="python"
fi

# --- 4. Effort 判断 ---
TOTAL_LINES=$((INSERTIONS + DELETIONS))
if [[ "$TOTAL_FILES" -le 3 && "$TOTAL_LINES" -le 100 ]]; then
  EFFORT="simple"
elif [[ "$TOTAL_FILES" -le 10 && "$TOTAL_LINES" -le 500 ]]; then
  EFFORT="medium"
else
  EFFORT="complex"
fi

# --- 5. 维度列表 ---
if [[ "$HARNESS_MODE" == "harness" ]]; then
  DIMENSIONS='["robustness","standards","taste","blr","integration"]'
else
  DIMENSIONS='["robustness","taste","standards","architecture","dataflow"]'
fi

# --- 6. Data-Flow 信号检测（仅 standalone） ---
DATAFLOW_SIGNALS=""
if [[ "$HARNESS_MODE" == "standalone" ]]; then
  # 检测跨模块关键词：匹配路径组件而非子串，避免 service-worker 误触发
  if echo "$DIFF_FILES" | grep -qE '(^|/)(api|routes?|services?|repositories?|store|dao|controllers?|handlers?)(/|$|\.)' 2>/dev/null; then
    DATAFLOW_SIGNALS="detected"
  fi
fi

# --- 7. 输出 JSON（awk 安全处理文件名中的特殊字符） ---
awk -v harness_mode="$HARNESS_MODE" \
    -v harness_dir="$HARNESS_DIR" \
    -v effort="$EFFORT" \
    -v against="$AGAINST" \
    -v primary_lang="$PRIMARY_LANG" \
    -v total_files="$TOTAL_FILES" \
    -v insertions="$INSERTIONS" \
    -v deletions="$DELETIONS" \
    -v dimensions="$DIMENSIONS" \
    -v dataflow_signals="$DATAFLOW_SIGNALS" '
BEGIN {
  print "{"
  print "  \"harness_mode\": \"" harness_mode "\","
  print "  \"harness_dir\": \"" harness_dir "\","
  print "  \"effort\": \"" effort "\","
  print "  \"against\": \"" against "\","
  print "  \"primary_lang\": \"" primary_lang "\","
  print "  \"total_files\": " total_files ","
  print "  \"insertions\": " insertions ","
  print "  \"deletions\": " deletions ","
  print "  \"dimensions\": " dimensions ","
  print "  \"dataflow_signals\": \"" dataflow_signals "\","
  print "  \"files\": ["
}
' 

# files 数组：逐行读取，awk 转义双引号和反斜杠
echo "$DIFF_FILES" | awk '
BEGIN { first = 1 }
{
  if (!first) printf ",\n"
  first = 0
  # 转义反斜杠和双引号
  gsub(/\\/, "\\\\", $0)
  gsub(/"/, "\\\"", $0)
  printf "    \"%s\"", $0
}
END { print "" }

# 闭合 JSON（由 subshell 完成文件列表后的闭合括号）
' 
echo "  ]"
echo "}"
