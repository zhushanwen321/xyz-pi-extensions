# 跨文档一致性终检（Consistency Final Check）

> Step 6c 引用（仅⑥执行计划阶段）。编码前对①-⑥全部 .md 做一次性总闸门审计。
> 与每阶段 Step 6b 的局部反哺区别：6b 是「本阶段 vs 直接上游」的增量检查；
> 6c 是「①-⑥全链 + 骨架代码」的总闸门检查。

## 为什么编码前需要总闸门

每阶段 Step 6b 保证了相邻阶段一致，但跨多阶段的矛盾可能累积：

- ①某用例的 AC 在③被细化，在⑤时序图漏了某条，⑥Wave 没排进去
- ②的 D-不可逆决策在④⑤被「理所当然地」偏离
- ④缓解项登记了去向，但⑤骨架/⑥Wave 实际没落地
- ⑤骨架代码与⑤时序图签名表漂移（生成后时序图改了，骨架没同步）

这些矛盾不在相邻阶段间暴露，到编码期才发现 = 返工。总闸门一次性扫清。

## Step 0：跑全部阶段机器检查（硬阻断，最先做）

[MANDATORY] 终检 subagent 先依次跑 6 个阶段的机器检查脚本（每个阶段 review 时已跑过，此处是编码前总复核）：

```bash
for phase in clarity architecture issues nfr code_arch execution; do
  skill="full-${phase/_/-}"
  python3 ${SKILL_DIR}/../$skill/scripts/check_${phase}.py {topic_dir}
done
```

任一脚本 exit 1（FAIL）= 总闸门 INCONSISTENT，矛盾回相应阶段 Step 3 处理。全 PASS 才进下面的 6 维跨文档审计。脚本覆盖：结构完整性 + 引用闭环（UC→issue→test-matrix→Wave）+ ⑤骨架反模式。

## 6 维检查

**【并行提速】拆 4 组并行 fresh-context subagent（按维度正交切，不按文档组切）。**

> **为何按维度切不按文档组切**：6 维中维 2（用例追溯①UC→③issue→⑤时序→⑥Wave）、维 3（AC 闭环①→③→⑤→⑥）、维 5（NFR 回灌④→⑤→⑥）都**跨文档组**——按①②/③④/⑤⑥ 切会断追溯链（⑤⑥组验不了①的 UC 落⑥Wave，③④组看不到⑤test-matrix 落点）。维度本身正交（每维读各自证据、输出各自矛盾，无一维结论依赖另一维），按维度切才是真并行单元。
>
> **maxConcurrent=4 刚好放下**（4 个并行 fresh subagent，符合 ≤5 并发约束）。

| 组（认知帧） | 跑的维度 | 主读 |
|---|---|---|
| **术语审计组** | 维 1 术语一致性 | 全 6 文档 + CONTEXT.md |
| **全链追溯审计组** | 维 2 用例可追溯 + 维 3 AC 覆盖闭环（合并：同走①→③→⑤→⑥链，省重复遍历） | 全 6 文档 |
| **决策守护审计组** | 维 4 决策一致性（②③ D-不可逆 vs ④⑤⑥） | 全 6 文档 |
| **落地审计组** | 维 5 NFR 回灌闭环 + 维 6 骨架↔文档一致（合并：都查"⑤是否真落地"） | 全 6 文档 + ⑤骨架代码 |

**被并行单元无依赖**：每维读各自证据、输出各自矛盾。维 6（骨架→⑥Wave 映射）与维 3（test-matrix→⑥Wave 覆盖）都查"⑥Wave 覆盖 X"但 X 不同（骨架叶子 vs 用例 ID），结论独立。

**两处串行约束（不可并行）：**
1. **Step 0 机器检查必须先依次跑完**（6 个阶段脚本依次串行 bash，全 PASS 才进并行 LLM 审计）
2. **合并写 consistency-final.md 是撞写层**，串行（主 agent 或 1 个 merge subagent 收集 4 组输出后写）

各并行组产出 `changes/consistency-{terminology|trace|decision|landing}.md`，主 agent 汇总后写 `consistency-final.md`。

### 维度 1: 术语一致性

- [ ] ①统一语言（CONTEXT.md）的每个术语，在②-⑥用词一致（无同义词混用、无未定义术语）
- [ ] 状态机 Status/Reason 枚举值在②⑤骨架一致

### 维度 2: 用例可追溯（全链不断）

- [ ] ①每个 UC → ③有对应 issue → ⑤有对应时序图 → ⑥有对应 Wave
- [ ] 无孤立 UC（①有但下游无落点）、无幽灵 Wave（⑥有但①无来源）

### 维度 3: AC 覆盖闭环

- [ ] ①UC AC → ③issue AC → ⑤test-matrix → ⑥Wave 验收，全覆盖无遗漏
- [ ] 每个 ⑤test-matrix 用例 ID 至少出现在一个 ⑥Wave 的「覆盖的 test-matrix 用例 ID」里
- [ ] ⑥所有 Wave 覆盖的 test-matrix 用例 ID 并集 = ⑤test-matrix 全部用例

### 维度 4: 决策一致性（未被静默推翻）

> **以 decisions.md 为权威索引。** decisions.md 记录了本 topic 所有已拍板决策（status=confirmed / revisited）。维 4 以 decisions.md 为准对账各阶段 .md，而非逐阶段 grep 决策记录章节。

- [ ] **decisions.md 里 status=confirmed 的决策，在①-⑥各 .md 中未被静默偏离**（尤其 D-不可逆：分层/状态机/领域边界/根本架构）
- [ ] 若有偏离，是否有 Step 6b 反哺记录（上游 .md 的 `[BACKFED]` 标注）+ **decisions.md 同步（原决策 status→revisited + superseded_by + 新决策 `[REVISIT]` 溯源）** + 用户重新确认（D-不可逆的 NEEDS_USER_CONFIRM）
- [ ] **decisions.md 的 revisit 链完整**：每个 status=revisited 的决策都有 superseded_by 指向，且新决策 confirmed_by=ask_user（D-不可逆）——没有「agent 自改了决策但没问用户」的漏网
- [ ] ②③的 D-不可逆决策（分层/状态机/领域边界/根本架构）在④⑤⑥未被静默偏离

### 维度 5: NFR 回灌闭环

- [ ] ④每条缓解项的去向（⑤章节/③新issue/运维项）实际落地
- [ ] ④标「⑤章节」的缓解项，在⑤签名表/骨架有对应字段
- [ ] ④标需⑤骨架验证的副作用，骨架已含相关 stub
- [ ] ④回灌到③的新 issue 在 issues.md 实际出现
- [ ] **④每条 `验收方式=代码测试` 的缓解项 → ⑤§6 来源B 有对应用例 → 该用例落在某⑥Wave 覆盖清单（全链闭环，非仅并发维度）**

### 维度 6: 骨架↔文档一致

- [ ] ⑤骨架的类/方法签名与⑤签名表一致（无漂移）
- [ ] ⑤骨架的 import 关系与⑤包依赖图一致
- [ ] ⑤骨架的每个叶子作用域映射到⑥一个 Wave（无骨架代码没被 Wave 覆盖）

## 结果处理

- **CONSISTENT** → 交接编码
- **INCONSISTENT** → 每条矛盾当 gap，回相应阶段 Step 3 处理：
  - 用例/AC 链断 → 回⑤或⑥补
  - 决策被推翻 → 回②或③ Step 6b 反哺流程（D-不可逆需 ask_user）
  - NFR 没落地 → 回⑤或⑥补
  - 骨架漂移 → 回⑤同步骨架与文档

修完后重跑 Step 6c，直到 CONSISTENT 才交接编码。

## frontmatter 契约（CW gate）

> **[MANDATORY] `consistency-final.md` 必须含 frontmatter `verdict`，与各阶段 review 文件的 `verdict: APPROVED` 同机制——CW gate（check-execution.ts）读 **frontmatter** 不读 heading，缺 frontmatter 或 verdict 值不对 = gate FAIL。

落盘格式：

```markdown
---
verdict: CONSISTENT   # 或 INCONSISTENT
---

# 跨文档一致性终检报告
...
```

- `verdict: CONSISTENT`（全 6 维通过）→ CW execution gate 认可，进编码
- `verdict: INCONSISTENT`（有未解决矛盾）→ 不落盘此文件，先回 Step 3 修矛盾重跑终检；落盘 INCONSISTENT 等于自报 gate FAIL

> **关键：** check-execution.ts 只认 frontmatter 的 `verdict` 字段，不解析正文 `## Verdict` 之类的 heading。agent 产 consistency-final.md 时**必须**写 frontmatter，不能只写正文 heading。这与 mid-plan/mid-detail-plan 的 `review-{slug}.md` 落盘 `verdict: APPROVED` 是同一套机制（见 `../mid-shared/references/review-fix-loop.md`「CW gate 落盘契约」节）。
