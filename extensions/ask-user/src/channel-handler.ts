// src/channel-handler.ts
//
// ask_user channel handler：把 subagent 子进程的 ask_user 请求透传到主进程 UI 渲染。
//
// 设计（关键决策）：askUserInteract（@xyz-agent/extension-protocol）只在 RPC 模式可用
// （内部 isGuiCapable 检查 mode==='rpc'，TUI 下抛错）。所以 handler 按 ctx.mode 分流：
//   - RPC：转发器——调 askUserInteract(guiCtx, protoQuestions)，复用 select 通道 +
//     ASK_USER_MARKER 契约，主进程 ctx.ui.select 经 GUI sidecar 渲染（不进 parseSpawnLine，
//     不循环）。返回 {value: JSON.stringify(answers)} 让子进程 JSON.parse(value) decode。
//   - TUI：走 ctx.ui.custom + AskUserComponent。三步：(1) protoQuestions → 内部 Question[]，
//     (2) ctx.ui.custom 渲染拿内部 Result，(3) 内部 Result.answers（key=question 全文，
//     value="label1, label2 — comment"）→ 重新编码为 proto AskUserAnswers（key=header/question，
//     单选=value，多选=JSON 数组，Other→__other，comment→__comment），让子进程 decode 一致。
//
// handler 收到的 req.channelPayload = {questions: AskUserQuestion[], allowCancel}（proto 格式，
// 由子进程 askUserInteract 编码、subagent-workflow parseChannel 解析 options[0] JSON 得到）。

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	askUserInteract,
	type AskUserAnswers,
	type AskUserQuestion,
} from "@xyz-agent/extension-protocol";

import { AskUserComponent } from "./component";
import { resolveHostMode } from "./host-mode-compat";
import { ANSWER_COMMENT_SEPARATOR, type Option, type Question, type Result, type ThemeLike } from "./types";

/**
 * channel handler 签名——与 subagent-workflow 的 UiChannelRegistry.ChannelHandler 一致
 *（(req: unknown) => Promise<unknown>）。本文件不静态 import subagent-workflow（它是可选
 * peerDep，未安装时静态 import 会导致整个 ask-user 加载失败）；注册时通过动态 import 拿
 * registry，handler 签名用本地等价类型，运行时结构兼容。
 */
export type ChannelHandler = (req: unknown) => Promise<unknown>;

/** handler 返回给 subagent-workflow 的 UiResponse 形状（dialog-queue.ts 定义）。
 *  - {value}: select 的回传值（子进程 JSON.parse(value) 得 answers）
 *  - {cancelled}: 用户取消 / 子进程 close / handler 抛错 */
type ChannelResponse = { value: string } | { cancelled: true };

/** handler 收到的 req 形状收窄（ChannelHandler 签名是 unknown，按形状 as 收窄）。
 *  channelPayload 由 subagent-workflow parseChannel 填充。 */
interface ChannelRequest {
	channelPayload?: { questions?: AskUserQuestion[]; allowCancel?: boolean };
}

/** proto AskUserQuestion → 内部 Question（AskUserComponent 接受内部格式）。
 *  proto options 可选（无 options=纯自由文本），内部 options 必填——无 options 的 protoQuestion
 *  这里仍映射出 options（从子进程 ask-user 调用方保证 protoQuestions 总带 options；若缺则返 [] 由调用方判）。 */
function protoToInternalQuestions(protoQuestions: AskUserQuestion[]): Question[] {
	return protoQuestions.map((pq: AskUserQuestion): Question => {
		const opts: Option[] = (pq.options ?? []).map((o: { label: string; description?: string }): Option => ({
			label: o.label,
			...(o.description !== undefined ? { description: o.description } : {}),
		}));
		return {
			question: pq.question,
			...(pq.header !== undefined ? { header: pq.header } : {}),
			...(pq.context !== undefined ? { context: pq.context } : {}),
			options: opts,
			...(pq.multiSelect !== undefined ? { multiSelect: pq.multiSelect } : {}),
			...(pq.allowComment !== undefined ? { allowComment: pq.allowComment } : {}),
		};
	});
}

/**
 * 把 TUI 路径产出的内部 Result.answers 重新编码为 proto AskUserAnswers。
 *
 * 内部 Result.answers：key = question 全文，value = "label1, label2 — comment"
 * （Other 自由文本与 selected 标签逗号拼接，comment 用 ANSWER_COMMENT_SEPARATOR 分隔）。
 *
 * proto AskUserAnswers 契约（@xyz-agent/extension-protocol）：
 *   - key = question.header ?? question 全文
 *   - 单选：value = 选中项 value string
 *   - 多选：value = JSON.stringify(选中项 value 数组)
 *   - Other 自由文本：单独 key `${header}__other`
 *   - comment：单独 key `${header}__comment`
 *
 * 解码（无信息丢失）：用 protoQuestion.options 的 label 集合精确匹配 selected；
 * 不匹配的 token = Other 自由文本；comment 由 ANSWER_COMMENT_SEPARATOR 切出。
 */
function encodeTuiResultToProto(
	protoQuestions: AskUserQuestion[],
	result: Result,
): AskUserAnswers {
	const answers: AskUserAnswers = {};
	for (const pq of protoQuestions) {
		const key = pq.header ?? pq.question;
		const internalText = result.answers[pq.question];
		if (internalText === undefined) continue; // 该问题未答（protoAnswersToResult 也跳过未答）

		// 已知选项 label 集合（protoQuestion.options 的 label/value 都作候选——value 缺失时用 label）
		const knownLabels = new Set<string>();
		for (const o of pq.options ?? []) {
			knownLabels.add(o.label);
			if (o.value !== undefined) knownLabels.add(o.value);
		}

		// 切 body / comment（comment 在 ANSWER_COMMENT_SEPARATOR 之后）
		const sepIdx = internalText.indexOf(ANSWER_COMMENT_SEPARATOR);
		const body = sepIdx >= 0 ? internalText.slice(0, sepIdx) : internalText;
		const comment = sepIdx >= 0
			? internalText.slice(sepIdx + ANSWER_COMMENT_SEPARATOR.length).trim() || undefined
			: undefined;

		// body tokens：匹配 knownLabels 的为 selected，其余为 Other 自由文本
		const tokens = body.split(/[,，]/).map((t: string) => t.trim()).filter((t: string) => t !== "");
		const selected: string[] = [];
		const otherTokens: string[] = [];
		for (const t of tokens) {
			if (knownLabels.has(t)) {
				// 回查 proto option 的 value（PR #85 #8）：TUI 渲染用 label，但 RPC 路径
				// （askUserInteract）回传的是 option.value。value≠label 时若直接 push label，
				// TUI/RPC 两条路径产出分裂。value 缺失时 fallback label（保持 ask-user 自身
				// toProtoQuestions 的 value=label 语义，以及历史行为）。
				const opt = pq.options?.find(o => o.label === t || o.value === t);
				selected.push(opt?.value ?? t);
			} else {
				otherTokens.push(t);
			}
		}
		const otherText = otherTokens.join(", ") || undefined;

		// 主 key：单选 = 首个选中 value；多选 = JSON 数组（即便为空也写入，与 RPC 契约一致）
		if (pq.multiSelect) {
			answers[key] = JSON.stringify(selected);
		} else if (selected.length > 0) {
			answers[key] = selected[0]!;
		}

		if (otherText) answers[`${key}__other`] = otherText;
		if (comment) answers[`${key}__comment`] = comment;
	}
	return answers;
}

/** TUI 路径：ctx.ui.custom + AskUserComponent 渲染，返回 proto answers 或 null（取消）。
 *
 *  allowCancel 透传预留（PR #85 #12）：AskUserComponent 构造函数暂未接收 allowCancel，
 *  Esc 取消始终可用（component.ts 的 escBackOrConfirm / cancel 无条件生效）。待组件升级
 *  支持禁用 Esc 后，应把 allowCancel 下传给 AskUserComponent 构造函数。当前 allowCancel=false
 *  时 TUI 与 RPC 路径仍有分裂，但 handler 层已不再吞掉 allowCancel（修复分裂的第一步）。 */
async function runTuiProtoInteraction(
	protoQuestions: AskUserQuestion[],
	ctx: ExtensionContext,
	allowCancel: boolean,
): Promise<AskUserAnswers | null> {
	const questions = protoToInternalQuestions(protoQuestions);
	// 预留：组件升级后此处改为 new AskUserComponent(questions, tui, theme, done, allowCancel)
	void allowCancel;
	const result = await ctx.ui.custom<Result | null>(
		(tui: unknown, theme: unknown, _kb: unknown, done: (r: Result | null) => void) => {
			const comp = new AskUserComponent(
				questions,
				tui as { requestRender(): void },
				theme as ThemeLike,
				done,
			);
			return comp;
		},
	);
	if (result === null || result.cancelled) return null;
	return encodeTuiResultToProto(protoQuestions, result);
}

/**
 * 创建 ask_user channel handler。
 *
 * @param ctx 主进程 ExtensionContext（session_start 时注入）
 * @returns ChannelHandler——req.channelPayload = {questions, allowCancel}（proto 格式），
 *          返回 {value: JSON.stringify(answers)} 或 {cancelled: true}
 */
export function createAskUserChannelHandler(ctx: ExtensionContext): ChannelHandler {
	return async (req: unknown): Promise<unknown> => {
		// req 正常是 subagent-workflow 构造的 UiRequest 对象；防御性收窄 null/undefined/
		// 非 object（handler 抛错会被 dialog-queue 兜底为 {cancelled:true}，但这里直接返回更干净）
		if (req === null || typeof req !== "object") {
			return { cancelled: true } satisfies ChannelResponse;
		}
		const r = req as ChannelRequest;
		const payload = r.channelPayload;
		if (!payload || !Array.isArray(payload.questions) || payload.questions.length === 0) {
			return { cancelled: true } satisfies ChannelResponse;
		}
		const { questions, allowCancel } = payload;

		// 按 host-mode 分流（PR #85 #13）：gui（rpc）走 askUserInteract（select 通道+sidecar），
		// tui/headless 走 ctx.ui.custom+AskUserComponent。用 resolveHostMode 替代 ctx.mode==="rpc"
		// 字面比较，集中化 mode 判定（host-mode.ts 设计）。两条路径都透传 allowCancel（#12）。
		const answers =
			resolveHostMode(ctx.mode) === "gui"
				? await runRpcForward(questions, ctx, allowCancel ?? true)
				: await runTuiProtoInteraction(questions, ctx, allowCancel ?? true);

		if (answers === null) return { cancelled: true } satisfies ChannelResponse;
		return { value: JSON.stringify(answers) } satisfies ChannelResponse;
	};
}

/** RPC 转发器：主进程 ctx.ui.select 经 GUI sidecar 渲染（不进 parseSpawnLine，不循环）。
 *  完整复用 askUserInteract 的 encode/decode 契约。 */
async function runRpcForward(
	questions: AskUserQuestion[],
	ctx: ExtensionContext,
	allowCancel: boolean,
): Promise<AskUserAnswers | null> {
	const guiCtx = {
		mode: ctx.mode,
		hasUI: ctx.hasUI,
		ui: { select: ctx.ui.select.bind(ctx.ui) },
	};
	return askUserInteract(guiCtx, questions, { allowCancel });
}
