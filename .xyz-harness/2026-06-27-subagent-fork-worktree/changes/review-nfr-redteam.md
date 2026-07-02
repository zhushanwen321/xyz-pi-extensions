---
verdict: APPROVED
machine_check: PASS
dimension: redteam
review_mode: parallel
phase: nfr
---

# 审查报告 — NFR（红队组）

## Verdict

**APPROVED**（必要性与比例性维度，红队反过度设计立场）。

NFR 设计在 13 issue × 7 维度规模上**没有可证的过度设计**。confirmed 决策的缓解项（D-021/D-022/D-024）均对应**真实破坏性故障路径**（删用户数据/数据黑洞/僵尸 record），deletion test 全部成立。纯类型/纯文档 issue 的 7 维度已自觉用「✅ 一行理由」瘦身（遵守 nfr-dimensions.md 反膨胀规则）。可观测性运维项严格走「运维项」列（不进开发 issue/测试）。

仅 2 处轻微可商榷点，**均不构成 CHANGES_REQUESTED**。

## Step 0 机器检查

7/8 passed。唯一 FAIL 是 `review-nfr 存在`（本次审查产出物，先有鸡先有蛋），按规则不视为硬阻断。machine_check: PASS。

## 过度设计发现

### 发现 1（轻微，不阻断）：recordId 白名单 `^[\w-]+$` 偏过度防御，但作者已诚实降级

- **对象**：回灌登记「recordId 白名单」(#4 安全)。
- **deletion test**：recordId 是系统内部生成 id，gitRun 用 execFileSync（非 shell=true，args 数组传参防 shell 注入）。**真正注入路径已被 execFileSync 数组传参 + recordId 内部生成双重堵死**。白名单是第三层防御，针对「recordId 生成逻辑未来若引入用户输入」这一假设性风险，无当前威胁模型支撑。删掉白名单，系统安全性不下降。
- **但作者处理得当**：未塞进③issue AC（AC-4.14 issues.md 不存在），而标「建议补 AC」+ 验收方式=骨架约束 + 回灌⑤契约。恰当降级——作为骨架约束（tsc 验存在性）非代码测试，成本极低，为防御纵深留口。
- **建议（非必须）**：可将「建议补 AC-4.14」收紧为「⑤骨架约束仅保留 recordId 来源注释，不引入运行时校验，除非未来 recordId 来源变为用户可控」。

### 发现 2（轻微，不阻断）：pid 复用兜底计数指标是边缘冗余，但属可接受监控设计

- **对象**：残余风险「pid 复用」监控方式「兜底触发计数指标」。
- **deletion test**：pid 复用是 D-021「概率正确非确定」残余风险，缓解是 24h 软超时（AC-12.3），指标纯是观测窗口。删掉指标——僵尸仍存在且最终被软超时收敛，只是不可观测。**风险本身不被该指标缓解**。
- **但**：(1) 不进开发 issue（运维项，零开发成本）；(2) 让"最坏 24h 隐形僵尸"可观测是合理运维诉求；(3) deliverable-template 明确「纯监控→运维项」是合法落点。**不构成过度设计**。
- **建议（非必须）**：运维项优先级排序时此指标标 P2/可选，优先实现 crashed/patchFailed/cleanup 失败率三项核心。

### 其余质询项——deletion test 全部成立（不过度）

| 质询对象 | deletion test 结论 |
|---------|-------------------|
| D-022 collectPatch 保 worktree | 删掉→patch 未生成+worktree rm+branch-D=改动彻底丢失（数据黑洞）。**必需** |
| D-024 reaper .alive 守卫 | 删掉→跨实例误删 A 活 worktree（rm 用户正在跑的工作目录）。**必需** |
| D-021 pid 探活/四分支 | 删掉→双实例并发 A 的 running 被误标 crashed。confirmed(ask_user)。**必需** |
| 12 条③回灌 AC | 抽查 AC-7.4/9.4/10.2/12.2/1.5/6.3/4.10 均在 issues.md 真实存在。是必要闭环指针，非冗余。**不过度** |
| 纯类型 #1/纯文档 #11 的 7 维度 | #1 有 4 个真实 ⚠️ breaking；#11 仅 1 ⚠️ 其余 ✅ 一行。**已自觉瘦身** |
| 4 条运维项 | 全走运维项列，不进开发 issue/test-matrix。**比例恰当** |
| ⑤骨架验证 4 项 | 全是 SDK 行为不确定副作用，符合"登记不实现"。**符合原则** |
| D-017 B9 兜底 | 删掉→record 卡 running+无 .finalized→重建误判 crashed。**必需** |

## 必须修改

**无必须修改项。**

confirmed 缓解项都有 deletion test 真证据，agent-opinionated 建议项已被作者自行做比例性降级处理。**红队判定：APPROVED。**
