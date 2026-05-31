---
phase: dev
verdict: pass
---

# Dev Phase Retrospect — context-engineering-rewrite

## 1. Phase Execution Review

### Summary

实现了 context-engineering v2 的 6 个 Task，通过两批 subagent 串行完成。最终产出 9 个变更文件（2 create + 7 modify），+874/-21 行，40 个测试全部通过（17 新增 + 23 原有）。

执行路径选择了复杂路径（6 tasks → subagent-driven），但实际编码合并为 2 批派遣（Task 1-3 + Task 4-6），因为所有 Task 共享 compressor.ts 必须串行。每批 subagent 用 memory 模式保持上下文连续性。

### Problems Encountered

1. **Subagent 空转**：Task 1-3 的 subagent 被派遣了两次。第一次派遣后返回"No result provided"，代码未变更，测试仍为 23 个。第二次派遣才成功产出 33 个测试通过的代码。根因不明，可能是 subagent 进程异常退出。代价是浪费了一轮等待时间。

2. **Task 4-6 subagent 同样空转一次**：同样的模式——第一次派遣无产出，第二次才成功。这暗示 subagent memory 模式在大 task prompt 下可能有稳定性问题。

3. **BLR 发现 2 个 MUST_FIX**：
   - **#1 ffState 跨 turn 丢失**：compressContext 内部每次创建新的 FrozenFreshState，index.ts 声明的 frozenFreshState 是死代码。这是 Task 2 subagent 的实现错误——它创建了 ffState 但没有修改 compressContext 签名来接收外部传入。
   - **#2 processBudget 只持久化 1 个**：while 循环缺失，只有 if 单次判断。这是 Task 2 的实现遗漏。
   
   两个 MUST_FIX 都由主 agent 手动修复（不违反禁码铁律——修复 BLR 发现的 bug 属于审查修复流程，不是新功能编码）。

4. **sed 替换测试文件的副作用**：用 sed 批量替换 compressContext 调用增加 ffState 参数时，漏掉了 `compressContext(orphaned, ...)` 这行（因为参数名不是 `messages`）。导致 1 个测试失败。手动修复。

5. **重复 import**：compressor.ts 中 FrozenFreshState 被导入了两次（原始 + 新增），导致编译错误。手动去重。

### What Would You Do Differently

1. **subagent task prompt 需要更明确的签名约束**：Task 2 的 subagent 没有意识到 compressContext 需要修改签名来接收 ffState。应该在 task prompt 中明确写出"compressContext 签名增加 ffState 参数，index.ts 传入闭包变量"。这次 prompt 只写了"compressContext 中串联新管道"，不够精确。

2. **测试文件的参数修改不应依赖 sed**：sed 批量替换容易漏行（如 `orphaned` 变量名）。应该让 subagent 自己在编码时一并更新所有调用点，或者用 TypeScript 编译器报错驱动修复。

3. **BLR 应该更早执行**：当前流程是全部 Task 编码完成 → 一次性 BLR。如果 Task 2 编码后就做 BLR，MUST_FIX 修复成本会更低（不需要回头改已经写好的 Task 3-6 代码）。这需要在"串行派遣"和"增量审查"之间做权衡。

### Key Risks for Later Phases

1. **frozen replacement 长度未计入预算**：processBudget 的 while 循环中，`totalFreshChars -= maxEntry.chars` 后加回 `replacement.length`，但 replacement 只是预览（previewSize chars），不是完整原文。BLR v2 和 Integration Review 都标记了这个 LOW 问题。如果 previewSize 设置过小，可能出现持久化后预算仍未降到阈值以下的极端情况（while 循环会继续持久化直到预算内或无 fresh entries，所以不会死循环）。

2. **findCompactBoundary 的字符串匹配**：用 `content.includes("compactionSummary")` 检测 compact boundary。如果 Pi 的 compact 消息格式变化（比如用 array content 而非 string），这个检测会失效。BLR v1 标记为 LOW，建议在 Phase 4 测试时验证实际格式。

3. **recall store 容量**：MAX_ENTRIES=500，Budget while 循环可能在极端情况下持久化大量 toolResult（如 50 个各 10K chars 的 toolResult 超 200K 预算）。LRU 淘汰会丢掉早期条目，导致 recall_context 返回 not found。

## 2. Harness Usability Review

### Flow Friction

- **subagent 空转问题**：两次派遣都出现了"No result provided"，需要手动检查代码是否变更、重新派遣。这增加了约 30% 的等待时间。如果 coding-workflow 扩展能自动检测 subagent 无产出并重试，会大幅改善体验。
- **MUST_FIX 修复流程**：当前流程是 BLR 发现问题 → 主 agent 手动修复 → 重新派遣 BLR v2。修复过程本身是正确的，但中间需要更新所有测试文件的 compressContext 调用签名，工作量比预期大。

### Gate Quality

- Gate 正确检测了所有必需文件的存在性和 YAML frontmatter 格式。
- BLR v1 的 2 个 MUST_FIX 是真实的实现缺陷（不是 false positive），审查质量好。
- 其他 3 个并行审查（Standards/Taste/Robustness）都是 verdict: pass, must_fix: 0，没有发现额外问题。

### Automation Gaps

- **subagent 空转检测**：coding-workflow 扩展没有检测 subagent 是否实际产出了代码变更。如果能在 subagent 返回后自动 `git diff --stat`，发现无变更则自动重试，会避免大量手动检查。
- **测试签名迁移工具**：当函数签名变化时，需要手动更新所有测试调用点。一个自动化的"更新所有 compressContext 调用"工具会很有用。TypeScript 编译器可以在 tsc 阶段捕获这些错误，但需要在编码 subagent 退出前运行 tsc。

### Time Sinks

- **subagent 空转等待**：约 10 分钟（两次派遣 × 5 分钟等待）
- **MUST_FIX 修复**：约 15 分钟（理解问题 → 修改 compressor.ts → 修改 index.ts → 更新测试文件 → sed 修复 → 手动修复遗漏行 → 去重 import → 验证）
- **审查文件同步**：review 文件在 main worktree 中生成，需要确认两边的文件同步

### Harness Suggestions

1. **编码 subagent 应在退出前运行 tsc 和 vitest**：如果 subagent 在返回前能自动 `npx tsc --noEmit && npx vitest run`，就能在交付前发现签名不匹配等问题，减少主 agent 的修复工作量。
2. **MUST_FIX 修复也应走 subagent**：当前主 agent 手动修复 BLR 发现的问题。如果修复量大，应该派遣一个专门的修复 subagent（传入 BLR 报告 + 需修复的文件），主 agent 只做验证。
