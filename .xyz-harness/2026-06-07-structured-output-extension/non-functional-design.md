---
verdict: pass
---

# Non-Functional Design — structured-output extension

## 1. 稳定性

改动对系统稳定性的影响是增量的——新增一个独立 extension，不修改核心 Pi 运行时。如果 extension 加载失败（Ajv 编译错误、env var 格式错误），静默跳过不影响 agent 正常执行。workflow 侧的改动是纯减法（移除 extractJSON 和 schema prompt），减少了一个已知的失败源。

风险缓解：FR-4 双层防护确保即使 turn_end + sendUserMessage 时序失效，agent-pool 的进程级重试仍能兜底。

## 2. 数据一致性

无持久化数据。structured-output 是无状态 extension——每次 session_start 重新读取环境变量、重新编译 schema。并行 agent 通过独立的 env var 和独立子进程实现隔离，无共享状态。agent-pool 侧的 `parsedOutput` 是一次性的 JSONL 解析结果，不涉及缓存一致性问题。

## 3. 性能

Ajv schema 编译在 session_start 时完成（一次性开销），运行时 validate 是 O(n) 遍历。pi 子进程启动时间增加约 50ms（ajv 模块加载），对 agent 总体执行时间（通常 10-60s）可忽略。`terminate: true` 比旧方案更省——避免了 agent 结束后再跑一个 LLM turn 的开销。

## 4. 业务安全

structured-output tool 的参数完全由 LLM 决定，但 Ajv schema 校验确保输出严格符合预期结构。tool_call hook 防止非 workflow 场景下的误用。无用户输入直接注入 schema 的路径（schema 由 workflow 脚本硬编码）。

## 5. 数据安全

`STRUCTURED_OUTPUT_SCHEMA` 环境变量在 pi 子进程内存中，不写入文件。子进程退出后环境变量随进程消亡。无敏感信息泄露风险。ajv 编译的 schema 缓存也是进程内内存，不持久化。
