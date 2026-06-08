# Code Review — Workflow Agent Discovery

## 总体评价
**需修改** — 2 个 medium 问题需修复，1 个 low 建议改进

## fallow 扫描摘要
fallow audit 对单文件无输出（变更文件非 JS 入口）。手动静态审查代替。

## 发现的问题

| 严重程度 | 位置 | 问题 | 建议 |
|----------|------|------|------|
| medium | `tests/agent-discovery.test.ts:80` | fixture 类型声明 `{ root, cleanup }` 缺少 `homeDir` 字段，但所有测试用例都访问 `fixture.homeDir`。tsc 不检查（测试被 exclude），但类型声明与实际不一致 | 修改类型为 `{ root: string; homeDir: string; cleanup: () => void }` |
| medium | `orchestrator.ts:20-21` | `import { homedir } from "node:os"` 和 `import * as os from "node:os"` 重复导入。`homedir()` 只用 2 处，`os.tmpdir()` 用 1 处 | 统一为 `import * as os from "node:os"`，调用 `os.homedir()` |
| low | `agent-discovery.ts:212,219-220` | `content.indexOf("---", 3)` 和 `content.slice(3, ...)` 中的数字 `3` 是 `---` 的长度。ESLint `no-magic-numbers` 已报警告 | 提取常量 `const FRONTMATTER_DELIMITER_LEN = 3` |

## 亮点

1. **测试覆盖全面** — 17 个测试覆盖所有边界条件（空目录、不存在路径、损坏 frontmatter、优先级覆盖、文件过滤）
2. **向后兼容** — 无 agent 字段时完全跳过，不影响现有 `agent("prompt")` 调用路径
3. **临时文件生命周期** — 在 stale context early return 和正常完成两个路径都做了清理
4. **优先级设计清晰** — last-writer-wins 通过 Map.set 覆盖机制自然实现，代码简洁
5. **可测试性** — AgentRegistry 构造函数接受 `homeDir` 参数，测试可以隔离 home 目录
6. **类型安全** — 无 `any`，接口完整，`DiscoveredAgent` 是值对象不可变
