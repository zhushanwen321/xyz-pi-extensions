---
verdict: pass
---

# E2E Test Plan — Workflow Agent Discovery

## Test Scenarios

### TS-1: Agent 文件发现（AC-1）

**场景**: 在多级路径放置 agent 文件，验证发现结果正确。

| Case | Setup | Expected |
|------|-------|----------|
| 发现 project agent | 在 `.pi/agents/foo.md` 放 agent 文件 | resolve("foo") 返回该文件内容 |
| 发现 npm 包 agent | 在 `node_modules/@zhushanwen/pi-coding-workflow/agents/` 放文件 | resolve("review-taste") 返回 |
| 优先级覆盖 | project 和 npm 包同名 agent | project 版本优先 |
| 跳过 _ 文件 | `.pi/agents/_draft.md` | 不被发现 |
| 跳过 chain 文件 | `.pi/agents/foo.chain.md` | 不被发现 |
| 无 frontmatter | `.pi/agents/bare.md`（无 `---`） | name="bare", systemPrompt=全文 |

### TS-2: agent() 调用集成（AC-2）

**场景**: workflow 脚本中使用 agent 名称调用。

| Case | Setup | Expected |
|------|-------|----------|
| 指定 agent 调用 | `agent({ agent: "review-taste", prompt: "..." })` | pi 子进程收到 `--append-system-prompt` |
| agent model 默认 | agent 文件 `model: ds-flash`，不传 model | 子进程使用 ds-flash |
| opts.model 覆盖 | agent 文件 `model: ds-flash`，传 `model: ds-pro` | 子进程使用 ds-pro |
| agent 不存在 | `agent({ agent: "nonexistent", prompt: "..." })` | 返回 `{ success: false, error: "Agent not found: nonexistent" }` |
| 旧语法不受影响 | `agent("just a prompt")` | 正常执行，无 system prompt 注入 |

### TS-3: 临时文件生命周期（AC-3）

| Case | Setup | Expected |
|------|-------|----------|
| 文件创建与删除 | 调用 agent 后检查 tmpdir | 子进程退出后文件被删除 |
| 并发无冲突 | 2 个并行 agent 调用 | 各自独立 UUID 文件名，互不影响 |

### TS-4: 缓存与失效（AC-4）

| Case | Setup | Expected |
|------|-------|----------|
| session_start 扫描 | 检查 session_start 后 registry 非空 | resolve() 可返回结果 |
| 不重复扫描 | 多次 resolve 调用 | 只在 session_start 时扫描一次 |

### TS-5: 向后兼容（AC-5）

| Case | Setup | Expected |
|------|-------|----------|
| 无 agent 字段 | 调用 `agent("prompt")` | 行为与修改前一致 |
| 空 registry | 没有 agent 文件 | 所有功能正常，status action 无 agents 字段 |

## Test Environment

- 本地开发环境，pi-workflow 扩展通过 `~/.pi/agent/extensions/` symlink 加载
- 测试 agent 文件手动放置到各路径
- 使用 `pi --mode json -p` 验证 `--append-system-prompt` 参数传递
