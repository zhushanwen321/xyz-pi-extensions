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
  skill="design-${phase/_/-}"
  python3 ${SKILL_DIR}/../$skill/scripts/check_${phase}.py {topic_dir}
done
```

任一脚本 exit 1（FAIL）= 总闸门 INCONSISTENT，矛盾回相应阶段 Step 3 处理。全 PASS 才进下面的 6 维跨文档审计。脚本覆盖：结构完整性 + 引用闭环（UC→issue→test-matrix→Wave）+ ⑤骨架反模式。

## 6 维检查

派独立 fresh-context subagent，读取全部 6 份 .md + CONTEXT.md + ⑤骨架代码目录。

**Task prompt 模板：**

```
你是独立一致性终检 subagent。上下文与主 agent 隔离。编码前对①-⑥全部文档做总闸门审计：
1. read 全部交付物：requirements.md, system-architecture.md, issues.md,
   non-functional-design.md, code-architecture.md, execution-plan.md
2. read 项目根 CONTEXT.md（统一语言）
3. read code-skeleton/（⑤骨架代码）

从 6 维检查跨文档一致性（见下），将矛盾逐条记录。
写入 {topic_dir}/changes/consistency-final.md（frontmatter verdict: CONSISTENT / INCONSISTENT）。
```

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

- [ ] ②③的 D-不可逆决策（分层/状态机/领域边界/根本架构）在④⑤⑥未被静默偏离
- [ ] 若有偏离，是否有 Step 6b 反哺记录 + 用户重新确认（backfed_from + NEEDS_USER_CONFIRM）

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
