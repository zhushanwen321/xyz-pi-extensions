/**
 * src/index.ts — Pi 事件入口 + 编排 + contextFile 排除（Adapter 入口层）
 *
 * 变化轴：Pi API/事件契约。default export 注册 session_start/before_agent_start handler。
 * [骨架] ③#6 + ②§6 Adapter 入口 + BC-8/10/13/14 + spec FR-3.2/FR-5/FR-6/FR-7。
 *
 * CA-12（SDK 证伪，骨架验证 Tier 2 发现）：SessionStartEvent 仅 {type,reason,previousSessionFile?}
 * 无 systemPromptOptions——contextFiles 仅 BeforeAgentStartEvent.systemPromptOptions.contextFiles 可得。
 * 故 session_start 只收集+缓存 collected rules+sourceMeta；before_agent_start 做
 * resolveNativeRealPaths(event...contextFiles)→filter→dedup→partition→build。
 * SV-3：闭包缓存变量生命周期（session_start 写一次 → before_agent_start 读多次，单 session 线性无竞态）。
 */
import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";

import { loadConfig, validateSource } from "./config.ts";
import { collectSources, isInHomeTree } from "./discovery.ts";
import {
  buildSuffix,
  dedupAndSort,
  partitionRules,
} from "./engine.ts";
import type { ConfigSource, RuleFile, SourceMeta } from "./types.ts";
import { kindRankOf } from "./types.ts";

/** 闭包缓存（SV-3：session_start 写一次，before_agent_start 读多次，单 session 无竞态）。 */
interface CachedRules {
  rules: RuleFile[];
  sourceMeta: SourceMeta;
}

/** stale context 容错判断（BC-10）。 [叶子] 纯判断。 */
function isStaleContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("Extension context no longer active")
  );
}

/** safeNotify：stale context 容错（isStaleContextError 吞，其余重抛，BC-10）。 [adapter] ctx.ui.notify。 */
function safeNotify(
  ctx: ExtensionContext,
  msg: string,
  type: "info" | "warning" | "error" = "info",
): void {
  try {
    ctx.ui.notify(msg, type);
  } catch (err) {
    if (!isStaleContextError(err)) throw err;
  }
}

/**
 * 解析 native contextFiles 的 realPath 排除集。realpathSync 失败的不纳入（保守，FR-3.2）。
 * [模块内直调] + [adapter] fs.realpathSync。 CA-12：在 before_agent_start 调（contextFiles 仅此事件可得）。
 */
function resolveNativeRealPaths(
  contextFiles: { path: string }[] | undefined,
): Set<string> {
  const set = new Set<string>();
  if (!contextFiles) return set;
  for (const f of contextFiles) {
    try {
      const real = fs.realpathSync(f.path);
      if (real) set.add(real);
    } catch {
      // realpath 失败（ENOENT/EACCES/symlink 断链）：不纳入排除集。
      // 保守策略——宁可让该文件重复注入，也不误排除原生 contextFile（FR-3.2/NFR-AC-6）。
      continue;
    }
  }
  return set;
}

/** 扩展入口（Pi 加载时调用）。 [adapter 真引SDK] pi.on() 注册 2 handler。 */
export default function systemPromptLoader(pi: ExtensionAPI): void {
  let cached: CachedRules = { rules: [], sourceMeta: new Map() };

  pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
    cached = handleSessionStart(ctx);
  });

  pi.on(
    "before_agent_start",
    (
      event: BeforeAgentStartEvent,
      _ctx: ExtensionContext,
    ): BeforeAgentStartEventResult | void => {
      return handleBeforeAgentStart(event, cached);
    },
  );
}

/**
 * walk 退化判定（CA-13/AC-14）：validSources 含 walk-files/walk-dirs 且 cwd 不在 home 子树。
 * 退化时 walkDirs 只扫 cwd 一级，若零收集需 notify（spec AC-14 不静默零加载无提示）。
 * inHomeTree 复用 discovery.isInHomeTree（保证与 walkDirs 判定一致，含 home===根 特判）。 [叶子] 纯判断。
 */
function isWalkDegraded(
  sources: ConfigSource[],
  cwd: string,
  home: string,
): boolean {
  const hasWalk = sources.some(
    (s) => s.kind === "walk-files" || s.kind === "walk-dirs",
  );
  if (!hasWalk) return false;
  return !isInHomeTree(cwd, home);
}

/**
 * session_start 编排：loadConfig→validateSource 逐条→构造 sourceMeta→collectSources（打 sourceId）→缓存。
 * **不去重/不分流/不排除 contextFile**（CA-12：contextFiles 仅 before_agent_start 可得）。
 * JSON 失败 safeNotify+降级空配置；source 失败 safeNotify+跳过；collected>0 notify 统计收集数。
 * [模块内直调] loadConfig/validateSource/collectSources/safeNotify + [adapter] homedir/Pi ctx。
 */
function handleSessionStart(ctx: ExtensionContext): CachedRules {
  const cwd = ctx.cwd;
  const home = homedir();
  const configPath = path.join(
    home,
    ".pi",
    "agent",
    "extensions",
    "system-prompt-loader",
    "config.json",
  );

  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    // JSON 解析失败 → 降级空配置（AC-6.6/NFR-AC-1）
    safeNotify(
      ctx,
      "System prompt loader: 配置 JSON 解析失败，已降级为空配置",
      "warning",
    );
    return { rules: [], sourceMeta: new Map() };
  }

  // 逐条校验，失败 safeNotify+跳过（AC-6.7/NFR-AC-2）
  const validSources: ConfigSource[] = [];
  const sourceMeta: SourceMeta = new Map();
  config.sources.forEach((source, idx) => {
    const v = validateSource(source, idx);
    if (!v.ok) {
      safeNotify(
        ctx,
        `System prompt loader: ${v.reason}，已跳过`,
        "warning",
      );
    } else {
      validSources.push(source);
    }
  });
  // 构造 sourceMeta（声明序+kindRank，FR-3.1）
  validSources.forEach((source, sourceId) => {
    sourceMeta.set(sourceId, {
      kindRank: kindRankOf(source.kind),
      declIdx: sourceId,
    });
  });

  const rules = collectSources(validSources, cwd, home);
  if (rules.length > 0) {
    safeNotify(
      ctx,
      `System prompt loader: ${rules.length} collected`,
      "info",
    );
  } else if (isWalkDegraded(validSources, cwd, home)) {
    // walk 退化零加载提示（CA-13/AC-14：不静默零加载无提示；③AC-5.3 notify 由 index 处理）
    safeNotify(
      ctx,
      "System prompt loader: walk 退化（cwd 不在 home 子树），仅扫 cwd 一级，未命中规则",
      "info",
    );
  }
  return { rules, sourceMeta };
}

/**
 * before_agent_start 编排（CA-12）：resolveNativeRealPaths(event...contextFiles)→filter→dedup→partition→build。
 * contextFiles 仅此事件可得（SDK 证伪）。有 suffix 返回含 systemPrompt 字段对象；无→void（BC-13）。
 * [模块内直调] resolveNativeRealPaths/dedupAndSort/partitionRules/buildSuffix + [adapter] Pi event。
 */
function handleBeforeAgentStart(
  event: BeforeAgentStartEvent,
  cached: CachedRules,
): BeforeAgentStartEventResult | void {
  const nativeRealPaths = resolveNativeRealPaths(
    event.systemPromptOptions.contextFiles,
  );
  const rules = cached.rules.filter(
    (r) => !nativeRealPaths.has(r.realPath),
  );
  const deduped = dedupAndSort(rules, cached.sourceMeta);
  const { unconditional, conditional } = partitionRules(deduped);
  const suffix = buildSuffix(unconditional, conditional);
  if (!suffix) return; // 零副作用（BC-13）
  return { systemPrompt: event.systemPrompt + "\n\n" + suffix };
}
