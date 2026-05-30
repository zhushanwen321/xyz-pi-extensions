---
verdict: pass
---

# Non-Functional Design — Evolve Skill Architecture Redesign

## 1. 稳定性

删除旧 evolution-engine 不影响 usage-tracker（两者独立，无代码引用关系）。evolve-daily 是极简 hook（~40 行），只做 `existsSync` 检查 + `pi.exec()` 调用 Python 脚本，失败仅 console.error，不阻塞 session。3 个 skill 是纯 Markdown 文档，不注册 tool/command，加载失败不影响 Pi 启动。唯一风险：如果 pending.json 格式损坏，evolve-apply skill 的 LLM 可能产出异常行为——缓解方式是 skill prompt 中包含格式校验步骤。

## 2. 数据一致性

pending.json 由 LLM 在用户手动触发 `/evolve` 时写入，单用户单 session 场景，无并发写入风险。history.jsonl 是追加写入，天然支持并发。daily-reports/ 的 JSON 文件由 Python analyzer 幂等生成（同一天内容一致）。evolve-apply 的 apply 操作涉及多步写入（edit 文件 + 更新 pending.json + 追加 history.jsonl），如果中途中断（如 session crash），pending.json 和 history.jsonl 可能不一致——但这已在 spec 中通过"失败时保持 pending 状态"的策略缓解。

## 3. 性能

evolve-daily 每天运行一次 Python analyzer，耗时取决于 session 数量（通常 < 10 秒）。3 个 skill 读取 JSON 文件（通常 < 1MB），毫秒级。`/evolve` 分析需要 LLM 推理，耗时取决于模型和 token 数量，无前端优化空间。无性能瓶颈。

## 4. 业务安全

SKILL.md 是 AI 行为指令，LLM 执行 apply 时直接修改文件。spec 明确限制 targetPath 为 `~/.pi/agent/` 下的 `.md` 文件（CLAUDE.md、SKILL.md 等），不涉及代码文件。LLM 自身判断安全性（不自动执行高风险操作），用户在 apply 前可审查建议内容。与旧 extension 相比，去掉了白名单机制（TypeScript 代码校验），换成了 LLM 判断——这是有意权衡：白名单维护成本高且容易过时，LLM 对上下文的理解更灵活。

## 5. 数据安全

backups/ 存储原始文件副本（cp 命令），权限与源文件一致。evolution-data/ 目录在用户 home 下（`~/.pi/agent/`），无敏感信息——内容是使用统计和 AI 行为建议。pending.json 和 history.jsonl 不包含用户代码或私密数据，仅包含文件路径和建议文本。
