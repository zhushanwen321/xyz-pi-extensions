# LLM 返回格式保证方案对比

**调研日期**：2026-07-27 | **置信度**：高（pi-ai API 源码确认 + structured-output 扩展源码精读）
**调研方式**：主 agent 亲自查 pi-mono 源码 + structured-output 扩展实现

---

## 核心结论

**推荐方案 A：直接调 LLM（streamSimple）+ JSON 格式约束 + 容错解析。**

理由：
1. Permission 的 AI Classifier 是**高频轻量判断**（每次工具调用一次），走主对话 + structured-output 工具调用成本过高（主对话 system prompt + 工具描述都要计费）
2. JSON 输出用"system prompt 强制 + 解析容错 + fallback"三层保证，可靠性足够（pi-permission-system 已验证）
3. 直接调 LLM 省 token（~200 token system prompt + ~50 token output）、省延迟（同进程）

---

## 方案对比

### 方案 A：直接调 LLM + JSON 约束（推荐）

```
streamSimple(model, { systemPrompt, messages }, { temperature: 0, maxTokens: 256 })
  → 累积 text → JSON.parse → 字段验证 → fallback 到 { outcome: "ask" }
```

**格式保证三层**：
1. **System prompt 强制**（pi-permission-system 的 ~200 token prompt）：
   ```
   Permission risk classifier. Given a tool invocation, respond JSON only.
   low risk→allow, uncertain→ask, destructive→deny.
   {"risk_level":"low"|"medium"|"high","outcome":"allow"|"ask"|"deny","reasoning":"brief","confidence":0.0-1.0}
   ```
   temperature=0 提高确定性。

2. **JSON 提取 + 解析**（pi-permission-system 的 `parseClassifierResponse`）：
   ```typescript
   // 模型可能把 JSON 包在 ```json ``` 代码块里，用正则提取
   const jsonMatch = raw.match(/\{[\s\S]*\}/);
   if (!jsonMatch) return fallback;
   const parsed = JSON.parse(jsonMatch[0]);  // 失败 → fallback
   ```

3. **字段验证 + fallback**：
   ```typescript
   const VALID_RISK_LEVELS = new Set(["low", "medium", "high"]);
   const VALID_OUTCOMES = new Set(["allow", "ask", "deny"]);
   // 字段缺失或非法 → 返回 { risk_level: "medium", outcome: "ask", ... }
   // 任何解析失败都 fallback 到 "ask"（交给用户审批，fail-safe）
   ```

**优点**：
- 省 token（不走主对话，不加载工具描述）
- 省延迟（同进程，无进程启动）
- 失败安全（解析失败 → ask → 用户审批）

**缺点**：
- 格式不是 100% 保证（弱模型可能输出非 JSON，但有 fallback 兜底）
- 需要自己写解析容错代码（~30 行）

### 方案 B：走主对话 + structured-output 扩展（不推荐用于 classifier）

structured-output 扩展（`extensions/structured-output/src/index.ts`）的机制：
1. 注册一个 `structured-output` 工具，参数是 `{ schema: JSON Schema, data: unknown }`
2. 模型调这个工具时，用 ajv 校验 data 是否符合 schema
3. turn_end hook 检查模型是否调了工具，没调则用 `pi.sendUserMessage({deliverAs: "steer"})` 强制重试（最多 2 次）

**优点**：
- 格式 100% 保证（ajv 校验 + 强制重试）
- 可复用现有扩展

**缺点（对 classifier 场景致命）**：
- **token 成本高**：走主对话意味着加载完整 system prompt + 所有工具描述（几千 token），而 classifier 只需 ~200 token
- **延迟高**：主对话一轮 = 模型思考 + 工具调用 + 校验，比直接 streamSimple 慢得多
- **并发问题**：classifier 需要在用户审批对话框显示时并发跑（Racing 设计），走主对话会与主对话循环冲突
- **steer 干扰**：structured-output 的 turn_end hook 会注入 steering message，污染主对话
- **设计意图不符**：structured-output 是为 workflow 子进程设计的（`PI_WORKFLOW_SCHEMA` 环境变量激活），不是为高频轻量判断设计的

**结论**：structured-output 适合"工作流产物结构化"（如 plan/test/report），**不适合 permission 的 AI Classifier**。

### 方案 C：走主对话但用独立子进程（vision 方式，不推荐）

vision 扩展用 spawn 子进程：`pi --mode json -p --no-session --model X --append-system-prompt Y --tools Z`

**缺点**：
- 进程启动开销大（Pi 初始化）
- 无法做 Racing（子进程无法与主进程的用户审批对话框并发协调）
- token 成本仍高于直接 streamSimple

---

## 方案 A 的完整实现要点

### System prompt 设计（借鉴 pi-permission-system + Codex guardian）

```
你是 AI coding agent 的权限风险分类器。给定一个工具调用，判断其风险等级并返回 JSON 决策。

风险等级：
- low: 只读、无副作用、不修改系统状态（ls/cat/grep/git status/读取文件）
- high: 破坏性、不可逆、影响系统安全（rm -rf/写系统目录/强制推送/执行远程脚本）
- medium: 介于两者之间（写工作区文件/普通 bash 命令/网络请求）

决策规则：
- low → outcome: "allow"（自动放行）
- high → outcome: "deny"（自动拦截，需人工审批）
- medium 或不确定 → outcome: "ask"（交用户审批）

只返回 JSON，不要任何其他文字：
{"risk_level":"low"|"medium"|"high","outcome":"allow"|"ask"|"deny","reasoning":"简短理由","confidence":0.0-1.0}
```

**省 token 关键**：
- system prompt ~150 token
- user prompt（工具调用信息）~50 token（toolName + command + path + cwd）
- output maxTokens=256（JSON 输出够用）
- temperature=0
- **不传 tools**（模型不能调工具，只能返回文本）

### 解析容错（pi-permission-system 的 parseClassifierResponse 模式）

```typescript
interface ClassifierResult {
  risk_level: "low" | "medium" | "high";
  outcome: "allow" | "ask" | "deny";
  reasoning: string;
  confidence: number;
}

const FALLBACK: ClassifierResult = {
  risk_level: "medium",
  outcome: "ask",  // fail-safe：解析失败交用户审批
  reasoning: "classifier parse failure",
  confidence: 0,
};

function parseClassifierResponse(raw: string): ClassifierResult {
  if (!raw) return FALLBACK;
  // 提取 JSON（可能包在 ```json ``` 里）
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return FALLBACK;
  let parsed: unknown;
  try { parsed = JSON.parse(jsonMatch[0]); } catch { return FALLBACK; }
  // 字段验证
  if (typeof parsed !== "object" || parsed === null) return FALLBACK;
  const obj = parsed as Record<string, unknown>;
  const risk_level = typeof obj.risk_level === "string" && ["low","medium","high"].includes(obj.risk_level) ? obj.risk_level : null;
  const outcome = typeof obj.outcome === "string" && ["allow","ask","deny"].includes(obj.outcome) ? obj.outcome : null;
  if (!risk_level || !outcome) return FALLBACK;
  return {
    risk_level,
    outcome,
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "no reasoning",
    confidence: typeof obj.confidence === "number" ? obj.confidence : 0.5,
  };
}
```

### 配置驱动的自动放行/拦截开关（pi-permission-system 模式）

```typescript
interface AiClassifierConfig {
  enabled: boolean;
  model: string;                  // "auto" | "provider/model-id"
  timeout: number;                // 秒，默认 90
  autoApproveLowRisk: boolean;    // 默认 true：low → allow
  autoDenyHighRisk: boolean;      // 默认 true：high → deny
}
```

- `autoApproveLowRisk: false` → 即使 AI 判 low 也交用户审批（极致安全）
- `autoDenyHighRisk: false` → 即使 AI 判 high 也交用户审批（避免误杀）

---

## 何时该用方案 B（structured-output）

方案 B（走主对话 + structured-output）**不适合 permission classifier**，但适合这些场景：
- workflow 子进程产出结构化结果（plan/test-report/retrospect）—— 这正是它设计的场景
- 需要与主对话共享上下文的复杂判断（classifier 不需要）

---

## Sources

- 方案 A 参考：`~/GitApp/ai-agent/pi-permission-system/src/ai-classifier.ts`（CLASSIFIER_SYSTEM_PROMPT:44, parseClassifierResponse:86, createClassifier:211）
- 方案 B 实现：`extensions/structured-output/src/index.ts`（完整 377 行）
- pi-ai API：`~/Code/git-fork/pi-mono-workspace/main/packages/ai/src/types.ts`（streamSimple 签名:224, AssistantMessageEvent:453）
- Codex guardian prompt（风险分类参考）：`~/GitApp/ai-agent/codex-cli/codex-rs/core/src/guardian/policy.md`
