# ADR-003: Evidence-based completion

Pi 的 Goal 强制要求任务分解 + 全部完成 + 具体证据才能标记目标完成。Codex 只要求模型自行判断目标是否达成。

这个选择的原因：Pi 的 Goal 面向的是"一定要完成"的自主循环，模型在预算压力下有强烈的偷工减料倾向（假装完成、跳过验证、把"找不到问题"当"已修复"）。强制 evidence 在 API 层阻止这种行为——`complete_task` 没有 evidence 参数会抛错，`complete_goal` 在 tasks 未全部完成时会抛错。

代价是灵活性降低：模型不能在任务列表不适用时跳过任务追踪（如探索性目标）。这种场景应该用 Todo 而非 Goal。
