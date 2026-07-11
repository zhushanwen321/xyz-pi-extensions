---
verdict: CONSISTENT
---

# 全文档一致性终检 — swf-scripts-docs-adr（T3）

> fresh subagent 对 6 份 deliverable + decisions.md 做跨文档矛盾 / decisions 一致性 / 测试闭环 / 反哺处理 四轴终检。

## 结论速览

| 轴 | 结果 | 说明 |
|----|------|------|
| 核心一致性链（6 对跨文档 + decisions + 测试闭环 + 反哺） | ✅ 全 PASS | requirements↔arch↔issues↔nfr↔code-arch↔execution 主链无矛盾；49 条测试 ID 双向闭环；D-030~D-033R 全有真实章节 |
| 补充文本缺陷 | ❌ 2 项实质 + 3 项 minor | 垂直切片统计数字自相矛盾；issues #8 悬空引用 |

**verdict = CONSISTENT**（修后）：INCONSISTENCY-1（垂直切片 33→35, 7→6）+ INCONSISTENCY-2（AC-8.4 悬空引用改为「与 #7 共同覆盖」）均已修复。核心设计链无矛盾。

---

## 1. 跨文档矛盾（逐对核对）

### 1.1 requirements ↔ architecture — ✅ 对齐

| 核对点 | 结果 |
|--------|------|
| G1~G5 目标 ↔ arch §1 目标转换表 | ✅ 5 目标全部映射，衡量标准一致 |
| UC-1~UC-11 ↔ arch §5 交付物 | ✅ 11 UC 对应 13 交付物（#1 覆盖 UC-1~4） |
| F1~F11 ↔ arch §5 | ✅ 11 Feature 全覆盖 |
| D-031 纯参考模板 ↔ arch §5 架构定位 | ✅ 一致（"参考模板，用户复制后执行"） |
| D-033R 部分 superseded ↔ arch §5 ADR 范围表 | ✅ ADR-029 标注"仅 worktree 编排被取代" |

### 1.2 architecture ↔ issues — ✅ 对齐（1 处 minor）

| 核对点 | 结果 |
|--------|------|
| 13 交付物 ↔ 8 issue | ✅ #1=4脚本 / #2=ADR-030 / #3=superseded / #4=skill-wf / #5=skill-exe / #6=AGENTS / #7=ext-deps / #8=deprecated |
| 分层归属（examples/ 新包、skill 跨包、ADR docs/adr/） | ✅ 一致 |
| ⚠️ arch §5 交付物范围表缺 CHANGELOG.md 行 | ⚠️ MINOR-3（见下）：§1/§7 已提及 CHANGELOG，仅 §5 表格未列行 |

### 1.3 issues ↔ nfr — ✅ 全覆盖

每个 issue 的副作用均被 nfr 对应维度覆盖：

| Issue | nfr 覆盖维度 |
|-------|-------------|
| #1 脚本 | 稳定(try-catch) / 兼容(files+lint) / 可维护(注释) / 一致(格式+并发) ✅ |
| #2 ADR-030 | 数据完整(append-only) / 可维护(引用) / 一致(四节) ✅ |
| #3 superseded | 数据完整(D-033R精确) / 可维护(原文) / 一致(措辞) ✅ |
| #4 skill-wf | 兼容(上限6+加载) / 可维护(分工) / 一致(来源) ✅ |
| #5 skill-exe | 可维护(转移) / 一致(原文) ✅ |
| #6 AGENTS | 可维护(目录) / 一致(check-structure) ✅ |
| #7 ext-deps | 兼容(迁移) / 一致(schema) ✅ |
| #8 deprecated | 数据完整(不可撤销) / 兼容(路径) / 可维护(CHANGELOG) / 一致(双处) ✅ |

### 1.4 issues ↔ code-arch §6（AC 覆盖） — ✅ 全覆盖

所有 issue AC 均有 §6 测试用例覆盖（T1.7 补 AC-1.4 已生效）：

| Issue | AC | 覆盖测试 |
|-------|-----|---------|
| #1 | AC-1.1~1.4 | T1.1/T1.2/T1.3/T1.7 ✅ |
| #2 | AC-2.1~2.4 | T5.1/T5.3/T5.5/T5.4 ✅ |
| #3 | AC-3.1~3.3 | T6.1/T6.2/T6.3 ✅ |
| #4 | AC-4.1~4.3 | T9.1/T9.2/T9.3 ✅ |
| #5 | AC-5.1~5.2 | T11.1/T11.2 ✅ |
| #6 | AC-6.1~6.3 | T7.1/T7.2/T7.3 ✅ |
| #7 | AC-7.1~7.3 | T8.1/T8.2/T8.3 ✅ |
| #8 | AC-8.1~8.4 | T10.1/T10.2/T10.3 + T8.4 ✅ |

### 1.5 nfr ↔ code-arch §6 来源 B — ✅ 全映射

nfr 回灌表 12 条缓解项 → code-arch §6 来源 B 拆为 14 行（lintScript/files 拆分 + 新增 T8.5 双向一致），全部映射到来源 A 测试 ID。无遗漏、无新增独立用例（纯文档主题特征）。

### 1.6 code-arch ↔ execution（Wave 依赖） — ✅ 推导正确

| code-arch §8 Wave DAG | execution 压缩 | 依赖保持 |
|----------------------|---------------|---------|
| #1 W1 / #2 W2 / #6 W6 / #7 W6（无依赖） | → W0 | ✅ |
| #3(dep#2) / #4(dep#1) | → W1(dep W0) | ✅ |
| #5(dep#3) / #8(dep#7) | → W2(dep W1) | ✅ #8 仅 dep #7，execution 正确识别 |

> ⚠️ MINOR-5：code-arch §8 写 #8 dep "Wave 6"（含 #6+#7），但 issues.md 明确 #8 only blocked_by #7。execution 更精确。非矛盾，属措辞偏宽。

---

## 2. decisions.md 一致性 — ✅

| 决策 | 对应 .md 真实章节 | §TBD 残留 |
|------|------------------|----------|
| D-030 维持 mid | requirements 决策记录表 + issues frontmatter `stage: mid-detail-plan` | 无 ✅ |
| D-031 纯参考模板 | requirements §7 约束 + arch §5 架构定位 + code-arch §5 | 无 ✅ |
| D-032 4 模板分开 | requirements F3/F4 + UC-3/UC-4 + arch §5 | 无 ✅ |
| D-033 ~~完全~~ | decisions.md status=superseded，被 D-033R 推翻 | 无 ✅ |
| D-033R 部分 superseded | requirements UC-6 AC-6.2 + arch §5 ADR 范围 + issues #3 AC-3.2/3.3 + code-arch §3.B | 无 ✅ |

D-033R 的"per-call cwd(types.ts:417/subagent-service.ts:302) + cw 调用(决策3-6)仍有效"在 decisions.md / arch §5 / code-arch §3.B 三处措辞一致。

---

## 3. 测试闭环 — ✅ ID 集合完全相等

```
code-arch §6 来源 A：49 unique IDs
execution 验收清单 ：49 unique IDs
diff（code-arch vs execution）：∅（空集，零差异）
```

测试层统计（两文档一致）：
- unit 35 (71%) / integration 10 (21%) / e2e 4 (8%) / perf-chaos 0 / **合计 49**

T1.4 编号缺口（review-fix-loop 改名）：code-arch 和 execution 均无 T1.4，AC-1.4 由 T1.7 覆盖。**两文档一致跳过 T1.4**，无单边遗漏。

来源 B 拆分：nfr 12 条 → code-arch 14 行（已拆分），无 §TBD 残留。

---

## 4. 反哺处理（review-fix-loop 标记项） — ⚠️ 部分未完全落实

| review-fix-loop 标记 | 修复状态 | 证据 |
|---------------------|---------|------|
| AC-1.4 缺测试 → 补 T1.7 | ✅ 已修 | code-arch T1.7 + execution T1.7 均存在，覆盖 AC-1.4 |
| 来源 B 拆分 | ✅ 已修 | code-arch §6 来源 B 14 行，逐条映射来源 A |
| 统计表自洽 | ⚠️ **统计表自洽但垂直切片不自洽** | 见 INCONSISTENCY-1 |

---

## INCONSISTENCY 清单

### INCONSISTENCY-1 [MUST-FIX]：execution-plan.md 垂直切片统计数字自相矛盾

**位置**：execution-plan.md §垂直切片说明

**问题**：prose 声称的 per-Wave 测试数与同文档的测试表格 + 统计表不一致：

| Wave | prose 声称 | 表格实际行数 | 差异 |
|------|----------|------------|------|
| W0 | 33 条 | **35 条** | ❌ −2 |
| W1 | 8 条 | 8 条 | ✅ |
| W2 | 7 条 | **6 条** | ❌ +1 |
| 合计 | 33+8+7=**48** | 35+8+6=**49** | ❌ 48≠49 |

**自相矛盾**：同一段落写"完成全部 49 条"，但 33+8+7=48≠49。

**根因推测**：prose 写于 T1.7（AC-1.4 补测试）加入前（W0 当时 33 条），T1.7 加入后表格更新为 35 但 prose 未同步；W2 数字 7 可能是早期含一条已删用例的残留。

**修复**：
```
- **W0** ...（33 条测试）   →  （35 条测试）
- **W2** ...（7 条测试）    →  （6 条测试）
```

### INCONSISTENCY-2 [SHOULD-FIX]：issues.md #8 AC-8.4 悬空交叉引用

**位置**：issues.md §#8 AC-8.4

**问题**：AC-8.4 写"旧两包条目在 ext-deps 标注 superseded（**与 #7 AC-7.4 对齐**）"，但 issue #7 只有 AC-7.1/7.2/7.3，**不存在 AC-7.4**。

**根因**：issue #7 未为"旧两包条目标注 superseded"设独立 AC（该 AC 留在 requirements UC-8 AC-8.4 层），issue #8 AC-8.4 试图交叉引用一个不存在的 issue 级 AC。

**影响**：AC 内容本身有效（T8.4 覆盖），仅交叉引用断裂。未来维护者按"#7 AC-7.4"查找会落空。

**修复（二选一）**：
- (A) issue #7 补 AC-7.4「旧两包条目标注 superseded（trace: UC-8 AC-8.4）」，与 #8 AC-8.4 对齐
- (B) issue #8 AC-8.4 改引用为「（trace: UC-8 AC-8.4）」，删除"与 #7 AC-7.4 对齐"

推荐 (A)：superseded 标注逻辑属 #7（ext-deps 更新），issue #7 应有此 AC。

---

## MINOR 清单（非阻断，建议顺带修）

### MINOR-3：system-architecture.md §5 交付物范围表缺 CHANGELOG.md 行

arch §5 表格列 13 行交付物，未含 `subagents/CHANGELOG.md` + `workflow/CHANGELOG.md`。但 §1 目标转换 G5 行 + §7 约束均已提及 CHANGELOG，code-arch §1/§3.B/§7 亦完整列出。仅 §5 表格缺行，不构成矛盾。建议补 2 行保持表格完整。

### MINOR-4：AC 命名空间重载（UC-N vs issue #N）

`AC-{N}.{seq}` 在 requirements UC-N 与 issues #N 间重载，因 issue 编号不与 UC 一一对应（issue #2=UC-5 内容，issue #5=UC-11 内容……），导致 AC-2.x / AC-5.x / AC-6.x / AC-7.x / AC-8.x 在两文档语义不同。code-arch §6 靠测试 ID 前缀（T2.x vs T5.x）消歧，逻辑无错，但阅读时需上下文判断。建议未来 topic 在 issue AC 加 issue 前缀（如 I2-AC-1）或在 trace 标注中始终用全限定（UC-N AC-N.x）。

### MINOR-5：code-arch §8 #8 依赖写"Wave 6"偏宽

code-arch §8 写 #8 dep "Wave 6（依赖声明已更新）"，Wave 6 = #6+#7。但 issues.md 明确 #8 only blocked_by #7。execution 正确识别为 dep #7。建议 code-arch §8 改"dep #7（Wave 6 同 Wave）"精确化。

---

## 修复优先级

| 优先级 | 项 | 工作量 |
|--------|----|--------|
| P0 MUST-FIX | INCONSISTENCY-1（垂直切片 33→35, 7→6） | 2 处数字 |
| P1 SHOULD-FIX | INCONSISTENCY-2（AC-7.4 悬空引用） | 1 行引用 |
| P2 nice-to-have | MINOR-3/4/5 | 各 1-2 行 |

修完 INCONSISTENCY-1 + 2 后 verdict 可翻为 CONSISTENT。
