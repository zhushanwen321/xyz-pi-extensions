"""配置：路径、阈值、常量。"""

import os
from pathlib import Path
from datetime import timedelta

# ── 路径 ──────────────────────────────────────────────
PI_AGENT_DIR = Path(os.path.expanduser("~/.pi/agent"))
SESSIONS_DIR = PI_AGENT_DIR / "sessions"
EVOLUTION_DATA_DIR = PI_AGENT_DIR / "evolution-data"
REPORTS_DIR = EVOLUTION_DATA_DIR / "reports"
DAILY_DIR = EVOLUTION_DATA_DIR / "daily"

# ── 信号提取阈值 ─────────────────────────────────────
# Signal 1: 工具使用
DUPLICATE_READ_THRESHOLD = 3  # 同一文件读取次数超过此值视为重复

# Signal 2: Token
TOKEN_HOTSPOT_PERCENTILE = 90  # token 消耗 top 百分位视为热点

# Signal 3: 错误
ERROR_KEYWORDS = [
    "error", "fail", "failed", "exception",
    "Could not find the exact text",
    "ENOENT", "permission denied",
    "non-zero exit code",
]

# Signal 4: 用户重复指令
USER_CORRECTION_KEYWORDS = [
    "不对", "不要", "别", "取消", "错了", "不是这样",
    "no,", "wrong", "not like this", "don't",
    "重新", "重来", "换个", "换一种",
]

# Signal 5: Skill
SKILLS_DIR = PI_AGENT_DIR / "skills"
SKILL_FILE_NAME = "SKILL.md"

# Signal 7: 满意度隐式信号
SINGLE_TURN_MAX_MESSAGES = 3  # user+assistant 消息数 <= 此值视为单轮完成

# ── 报告 ──────────────────────────────────────────────
TOP_N_PROBLEMS = 10
TOP_N_PATTERNS = 10
TOP_N_SKILLS = 20

# ── 性能 ──────────────────────────────────────────────
MAX_FILES_PARALLEL = 8  # 并行解析文件数
BATCH_SIZE = 50  # 批量处理 session 数
