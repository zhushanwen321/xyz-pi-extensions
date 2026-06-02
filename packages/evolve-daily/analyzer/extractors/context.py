"""计算估算的上下文窗口利用率。"""

from typing import Any

# 模型 context limit 映射（已知模型）
MODEL_CONTEXT_LIMITS: dict[str, int] = {
    "claude-sonnet-4": 200_000,
    "claude-haiku-3.5": 200_000,
    "deepseek-v3": 64_000,
    "deepseek-r1": 64_000,
    "gpt-4o": 128_000,
    "gpt-4o-mini": 128_000,
}


def estimate_tokens_from_chars(char_count: int, text_sample: str = "") -> int:
    """粗略估算 token 数。

    如果有 text_sample，按中英文字符比例估算。
    否则使用保守的混合比例 0.5 token/char。

    Args:
        char_count: 字符总数。
        text_sample: 用于估算中英文比例的文本样本。

    Returns:
        估算的 token 数。
    """
    if char_count == 0:
        return 0
    if text_sample:
        chinese_chars = sum(1 for c in text_sample if "\u4e00" <= c <= "\u9fff")
        ratio = chinese_chars / len(text_sample)
        # 混合比例：中文 ~1.5 token/char，英文 ~0.25 token/char
        return int(char_count * (ratio * 1.5 + (1 - ratio) * 0.25))
    # 无样本时使用保守的混合比例
    return int(char_count * 0.5)


def _extract_content_length(msg: dict) -> int:
    """提取消息内容的字符数。"""
    # 处理嵌套的消息格式 (msg.message.content)
    message = msg.get("message", msg)
    content = message.get("content", "")
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        return sum(
            len(item.get("text", ""))
            for item in content
            if isinstance(item, dict) and "text" in item
        )
    return 0


def extract(sessions: list[dict]) -> dict:
    """从 session 列表中提取上下文利用率统计。

    通过累积消息字符数估算上下文使用量，结合模型 context limit 计算利用率。

    Args:
        sessions: session JSONL 解析后的字典列表。

    Returns:
        包含上下文利用率分布、峰值、模型映射等统计信息。
    """
    models_used: set[str] = set()
    context_limits: dict[str, int] = {}
    utilization_samples: list[float] = []
    compact_at_high_utilization = 0
    total_compacts = 0

    for session in sessions:
        messages = session.get("messages", [])
        current_model: str | None = None
        cumulative_chars = 0

        for msg in messages:
            # 检查 model_change 事件
            if msg.get("type") == "model_change":
                model_id = msg.get("modelId", "")
                if model_id:
                    current_model = model_id
                    models_used.add(model_id)
                    if model_id in MODEL_CONTEXT_LIMITS:
                        context_limits[model_id] = MODEL_CONTEXT_LIMITS[model_id]

            # 累积消息字符数
            cumulative_chars += _extract_content_length(msg)

            # compact 事件
            if msg.get("type") == "compaction":
                total_compacts += 1
                if current_model and current_model in MODEL_CONTEXT_LIMITS:
                    limit = MODEL_CONTEXT_LIMITS[current_model]
                    estimated_tokens = estimate_tokens_from_chars(cumulative_chars)
                    utilization = estimated_tokens / limit
                    if utilization >= 0.7:
                        compact_at_high_utilization += 1
                    utilization_samples.append(utilization)
                # compact 后重置累积
                cumulative_chars = 0

        # session 结束时记录最终利用率
        if (
            current_model
            and current_model in MODEL_CONTEXT_LIMITS
            and cumulative_chars > 0
        ):
            limit = MODEL_CONTEXT_LIMITS[current_model]
            estimated_tokens = estimate_tokens_from_chars(cumulative_chars)
            utilization = estimated_tokens / limit
            utilization_samples.append(utilization)

    # 计算统计
    avg_utilization = sum(utilization_samples) / max(len(utilization_samples), 1)
    peak_utilization = max(utilization_samples) if utilization_samples else 0.0

    # 分布桶
    distribution = {"0-30%": 0, "30-60%": 0, "60-90%": 0, "90%+": 0}
    for u in utilization_samples:
        if u < 0.3:
            distribution["0-30%"] += 1
        elif u < 0.6:
            distribution["30-60%"] += 1
        elif u < 0.9:
            distribution["60-90%"] += 1
        else:
            distribution["90%+"] += 1

    return {
        "models_used": sorted(models_used),
        "context_limits": context_limits,
        "avg_estimated_utilization": avg_utilization,
        "peak_estimated_utilization": peak_utilization,
        "utilization_distribution": distribution,
        "compact_at_high_utilization": compact_at_high_utilization,
        "total_compacts": total_compacts,
    }
