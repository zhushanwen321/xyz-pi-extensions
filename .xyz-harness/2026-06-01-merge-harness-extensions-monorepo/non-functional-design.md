---
verdict: pass
---

# Non-Functional Design — Monorepo 合并

## 1. 稳定性

迁移是纯结构重构，不改变任何 extension 的运行时逻辑。主要风险点是 coding-workflow 的 subagent 去重——如果 pi-subagent 包的 `runSingleAgent` 等效功能（通过 SpawnManager）与 coding-workflow 内部实现的调用签名不同，可能引入运行时错误。缓解措施：Task 6 中先对比签名差异，必要时写适配层，再通过 CP-2 验证。

## 2. 数据一致性

不适用。本次迁移不涉及数据库、配置文件格式变更或持久化状态变更。Pi 的 `appendEntry` 和 `sessionManager` 机制不受目录结构变更影响。

## 3. 性能

`resources_discover` 在 `session_start` 时扫描 `skills/` 目录。每个 skill 目录只检查 SKILL.md 是否存在（`fs.existsSync`），不读取文件内容。20-30 个 skill 的扫描开销可忽略（< 10ms）。`pnpm install` 的 workspace 链接是符号链接操作，不影响运行时性能。

## 4. 业务安全

Skill 文件（SKILL.md）是 AI 行为指令，内容在 Pi 进程中作为 prompt 注入。迁移不改变任何 skill 的内容，只是移动文件位置。`resources_discover` 的路径通过 `__dirname` 相对定位，不涉及用户输入，无路径遍历风险。

## 5. 数据安全

不适用。本次迁移不涉及敏感信息处理、文件权限变更或网络操作。所有操作在本地文件系统内完成。
