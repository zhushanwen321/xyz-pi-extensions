# Tracing Round 2

**verdict: NOT_CONVERGED — 1 新 gap (G-017, D)**

## 追踪范围
- spec 版本：v2（FR-1 至 FR-15，AC-1 至 AC-18，已修复 Round 1 的 16 个 gap）
- 追踪的视角：User Journey、Data Lifecycle、API Contract、State Machine、Failure Path（全 5 视角，无降级）
- 方法：从零完整重跑 5 视角（隔离上下文）

## Round 1 的 16 个 gap 修复验证

| Gap | 修复位置 | 验证结果 |
|-----|---------|---------|
| G-001 signal abort | FR-11 | ✅ 到位 |
| G-002/G-013 comment 触发 | FR-4 item6 + FR-12 | ⚠️ 修复方向明确，引入 G-017 |
| G-003 timeout 语义 | FR-9 | ✅ 到位 |
| G-005 comment 存储字段 | FR-12 | ✅ 到位 |
| G-006 _resolved guard | FR-13 | ✅ 到位 |
| G-007 multiSelect join 顺序 | FR-7 | ✅ 到位 |
| G-008 校验失败返回 | FR-2 + AC-14 | ✅ 到位 |
| G-009 header schema | FR-2 | ✅ 到位 |
| G-010 timeout 边界 | FR-9 | ✅ 到位 |
| G-011 renderCall/Result 组件 | FR-10 | ✅ 到位 |
| G-012 已确认回改 | FR-15 | ✅ 到位 |
| G-014 clearTimeout | FR-9 + AC-16 | ✅ 到位 |
| G-015 custom factory 异常 | FR-14 | ✅ 到位 |
| G-016 并发调用 | Constraints | ✅ 到位 |

**结论：15 个完全到位，1 个（G-013）引入新 gap。**

---

## 新发现 gap

| ID | Type | Perspective | Question |
|----|------|------------|----------|
| G-017 | D | User Journey | FR-4 item6 定义了"评论输入行"，但 FR-6 输入处理表无对应按键行。评论输入行用何组件实现？评论上下文下 Enter/Space/Esc 各是什么行为？如何编辑/清除已输入评论？多选+评论时评论行何时出现？ |

---

## 走查记录

### 视角: User Journey

**OP-U01 单问题（评论路径）** ← G-017 所在
- allowComment=true 时选中选项后显示评论输入行，但：
  - (a) 评论输入行组件未定义（复用 Other 的 Editor？独立组件？ctx.ui.input？）
  - (b) FR-6 输入处理表无评论上下文行
  - (c) 评论编辑/清除路径未定义
  - (d) 多选+评论触发时机未定义

**OP-U02/U03/U04**：无新 gap。

### 视角: Data Lifecycle / API Contract / State Machine / Failure Path
- Round 1 的 gap 修复全部到位，无新 gap。
- Failure Path 覆盖完整：无 UI/signal abort/custom 异常/timeout/重入/clearTimeout 全部有恢复路径。

---

## 收敛判定

**未收敛。** 1 个新 D 类 gap（G-017）。G-017 是 G-013 修复引入的新交互模型细节缺漏。

建议：FR-6 表补充"评论输入行"上下文按键行；FR-4 item6 明确评论组件（复用 Other 的 Editor 实例）和多选+评论触发时机。
