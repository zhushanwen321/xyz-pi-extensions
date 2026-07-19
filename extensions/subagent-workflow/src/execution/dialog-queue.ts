// src/execution/dialog-queue.ts
//
// L2 跨子进程全局 dialog 串行队列。
//
// 进程单例语义：跨所有子进程共享，串行所有 dialog 类 UI 请求
//（isDialogMethod(method)===true，即 select/confirm/input/editor）。
//
// 设计动机（.fix-plans/00-master-summary.md §一 冲突 3）：
//   - L1 per-child 队列（session-runner.createUiRequestQueue）只解决同一子进程内的串行，
//     多个并行子进程仍可同时把 dialog 请求涌向父 UI（争输入焦点）。
//   - L2 全局队列在主 agent handler 入口前再串行一次，保证同一时刻主 agent 只呈现一个 dialog。
//   - 排队绑定 method 交互模型（dialog 才排队），不绑定 channel——排队是 Pi 协议固有属性。
//
// SR-4（child close reject）：入队项带 child 引用，child close 时把该 child 的 pending dialog
//   全部 resolve 为 {cancelled:true}，防 Promise 永挂 + 内存泄漏。
//
// handler 抛错兜底：catch → 回 {cancelled:true} → 继续处理下一个。不能让一个失败卡死队列。
//
// 调用方约定：只对 dialog 类（isDialogMethod===true）调 enqueue；fire-and-forget 由调用方
//   直接调 handler（见 ui-request-handler-factory.ts），不经过本队列。enqueue 内仍防御性兼容
//   fire-and-forget（万一调用方未判）：直接调 handler 返回，不入队串行。调用方不应依赖此防御。

import { isDialogMethod } from "./ui-interaction-model.ts";

// ── 类型定义（本模块是 UiRequest/UiResponse/UiRequestHandler 的规范来源） ──
// session-runner.ts 和 ui-channels.ts 复用这些类型（session-runner 再导出供测试 import）。

/** Pi extension_ui_request 的方法枚举（dialog + fire-and-forget 两类）。
 *  dialog 类：select/confirm/input/editor（占输入焦点，等响应）。
 *  fire-and-forget 类：notify/setStatus/setWidget/setTitle/set_editor_text（纯展示/写入）。
 *  (string & {}) 兜底：Pi 未来新增 method 或未知 method 走字符串字面量类型。 */
export type UiMethod =
  | "select"
  | "confirm"
  | "input"
  | "editor"
  | "notify"
  | "setStatus"
  | "setWidget"
  | "setTitle"
  | "set_editor_text"
  | (string & {});

/** UI 请求（session-runner 构造后传给 handler）。
 *
 *  method 是判别字段，决定排队策略（dialog 排队）和业务路由（channel 分发）。
 *  method 特定字段按 method 可选出现（与 ExtensionUiRequest 1:1，由 session-runner 从
 *  ExtensionUiRequest 平铺构造）。channel/channelPayload 由 parseChannel 填充。
 *
 *  契约来源：.fix-plans/00-master-summary.md §二 2.2。 */
export interface UiRequest {
  /** Pi rpc-types.ts 的 method（select/confirm/input/editor 为 dialog 类）。 */
  method: UiMethod;
  /** 请求 id（从 extension_ui_request envelope 顶层提取，用于 response 关联）。 */
  id: string;
  // method 特定字段（按 method 可选，与 ExtensionUiRequest 1:1）
  title?: string;
  options?: string[];
  message?: string;
  placeholder?: string;
  prefill?: string;
  notifyType?: string;
  statusKey?: string;
  statusText?: string | undefined;
  widgetKey?: string;
  widgetLines?: string[] | undefined;
  widgetPlacement?: "aboveEditor" | "belowEditor";
  text?: string;
  timeout?: number;
  /** channel 名（从 method 对应字段的 NUL 前缀解析）。
   *  select → 从 title 解析；setWidget → 从 widgetLines[0] 解析；其他 → undefined。
   *  已知值："ask_user"（select）、"gui_widget"（setWidget）。handler 按 channel 分发。 */
  channel?: string;
  /** channel 解析后的结构化 payload（已 JSON.parse）。
   *  ask_user: {questions, allowCancel}；gui_widget: {component}；无 channel: undefined。 */
  channelPayload?: unknown;
  /** 内部元数据字段：发起该 UI 请求的子进程 pid（由 session-runner.handleUiRequest 从
   *  child.pid 填入）。L2 队列据此关联 rejectChildDialogs（child close 时批量 reject）。
   *  下划线前缀表示内部字段，非 Pi 协议字段，不参与 stdin 回写。 */
  _childPid?: number;
}

/** UI 响应（handler 返回，session-runner 按 shape 回写 stdin）。
 *  - {value}: select/input/editor 的答案
 *  - {confirmed}: confirm 的答案
 *  - {cancelled}: 取消（child close / handler 抛错 / 用户取消）
 *  - {ack}: fire-and-forget（当前不透传到 TUI，留作协议完整） */
export type UiResponse =
  | { value: string }
  | { confirmed: boolean }
  | { cancelled: true }
  | { ack: true };

/** UI 请求 handler 签名（单函数，按 req.method 内部路由）。
 *  实现方负责：channel 业务路由（ask_user → AskUserComponent）+ 默认转发（ctx.ui.*）。
 *  抛错由调用方（DialogGlobalQueue / session-runner）兜底为 {cancelled:true}。 */
export type UiRequestHandler = (req: UiRequest) => Promise<UiResponse>;

// ── DialogGlobalQueue 实现 ──

/** 入队项的 child 引用形状（只取 pid 用于 rejectChildDialogs 匹配）。 */
export interface DialogChildRef {
  pid: number;
}

/** enqueue 的可选项。child 用于 rejectChildDialogs 关联（child close 时批量 reject）。 */
export interface EnqueueOptions {
  child?: DialogChildRef;
}

/** 队列内一项：请求 + handler + resolve + 所属 child。
 *  pending 状态持有 resolve，handler 完成 / rejectChildDialogs 时调它 settle Promise。
 *  settled 标志保证只 settle 一次（rejectChildDialogs 与 handler 完成可能竞争）。 */
interface QueueItem {
  req: UiRequest;
  handler: UiRequestHandler;
  resolve: (resp: UiResponse) => void;
  childPid: number | undefined;
  /** 是否已 settle（防 handler 完成 / rejectChildDialogs 重复 resolve）。 */
  settled: boolean;
}

/**
 * L2 跨子进程全局 dialog 串行队列（进程单例）。
 *
 * 用法（createUiRequestHandlerForMode 返回的总 handler 内）：
 * ```ts
 * const dialogQueue = new DialogGlobalQueue();
 * return async (req: UiRequest) => {
 *   // 调用方负责判断：dialog 入队，fire-and-forget 直接调 realHandler
 *   if (isDialogMethod(req.method)) return dialogQueue.enqueue(req, realHandler);
 *   return realHandler(req);
 * };
 * ```
 *
 * 语义保证：
 *   - FIFO 串行：前一个 handler settle 后才处理下一个
 *   - SR-4：rejectChildDialogs(child) 把该 child 的 pending 全部 resolve 为 {cancelled:true}
 *   - handler 抛错兜底：catch → {cancelled:true} → 继续下一个（队列不卡死）
 *   - 调用方约定只对 dialog 类调 enqueue；fire-and-forget 由调用方直接调 handler 不入队
 *（enqueue 内仍防御性兼容 fire-and-forget，但不保证行为）
 *
 * 线程模型：纯 Promise + 微任务驱动，无锁。Node 单线程 event loop 保证队列状态一致。
 *
 * 单 session 假设（M-2，与 index.ts lastSessionId 同源）：本队列是进程级单例（实例挂在
 * globalThis[Symbol.for("@zhushanwen/pi-subagents.dialogQueue")]，见 getOrCreateDialogQueue）。
 * rejectAll()/clear() 清空所有 pending dialog——无 per-session 隔离。Pi 当前架构保证单进程
 * 单 session 串行（同进程不会并发多个 session），故 session_shutdown 调 rejectAll() 只会清掉
 * 当前 session 的 pending。若未来 Pi 支持同进程多 session 并发，session A 退出会误清 session B
 * 的 pending dialog——届时需改为 per-session 隔离（入队项 QueueItem 带 sessionId，rejectAll
 * 改 rejectAllForSession(sessionId)，session_shutdown 只清当前 session）。
 */
export class DialogGlobalQueue {
  /** 等待处理的队列（FIFO）。正在处理的项从 queue shift 出后由 current 持有。 */
  private queue: QueueItem[] = [];
  /** 正在处理的项（handler 已调、未 settle）。用于 rejectChildDialogs 取消占位中的 dialog。 */
  private current: QueueItem | undefined;
  private processing = false;

  /**
   * 入队一个 UI 请求，返回 Promise<UiResponse>。
   *
   * 调用方约定：只对 dialog 类（isDialogMethod===true）调 enqueue。fire-and-forget 由
   * 调用方（ui-request-handler-factory.ts）在 enqueue 前判 isDialogMethod 后直接调 handler，
   * 不经过本队列。enqueue 内仍防御性兼容 fire-and-forget（万一调用方未判）：直接调 handler 返回，
   * 不入队串行，但调用方不应依赖此防御行为。
   *
   * dialog 项处理（TC-E4 case 1）：进队列 FIFO 串行，等前一个 settle 后才调 handler
   *（争输入焦点，防并发弹窗）。
   *
   * handler 抛错兜底：catch → 回 {cancelled:true}（dialog 路径，队列不卡死）。
   * SR-4：opts.child 用于 rejectChildDialogs 关联（dialog 项会被批量 reject，含 current）。
   *
   * @param req UI 请求（约定只传 dialog 类；fire-and-forget 防御性兼容）
   * @param handler 真正执行请求的 handler（TUI/GUI 模式分流后的 realHandler）
   * @param opts 可选 child 引用（用于 rejectChildDialogs 关联）
   * @returns handler 的响应；dialog 抛错时回 {cancelled:true}；child close 时回 {cancelled:true}
   */
  enqueue(
    req: UiRequest,
    handler: UiRequestHandler,
    opts?: EnqueueOptions,
  ): Promise<UiResponse> {
    // 防御性兼容 fire-and-forget：调用方约定不应传此类 req 进 enqueue（factory 层已判
    // isDialogMethod 直接调 handler），但万一调用方未判，这里直接调 handler 不入队，避免阻塞。
    // 直接返回 handler 真实结果（不做兜底形变为 cancelled——fire-and-forget 无串行语义）。
    if (!isDialogMethod(req.method)) {
      return handler(req);
    }
    // dialog：入队 FIFO 串行
    return new Promise<UiResponse>((resolve) => {
      this.queue.push({
        req,
        handler,
        resolve,
        childPid: opts?.child?.pid,
        settled: false,
      });
      void this.processNext();
    });
  }

  /**
   * settle 一个 item（幂等）。handler 完成 / rejectChildDialogs / rejectAll 都通过本方法，
   * settled 标志保证只 settle 一次（防竞争）。
   *
   * #19 单一推进点：本方法 settle Promise + 清状态后，**唯一**调 processNext 推进队列。
   * processNext 尾部不再调 processNext（旧代码双重推进，虽靠 processing 标志幂等，但语义混乱）。
   * 为什么推进必须在 settleItem 而非 processNext 尾部：rejectChildDialogs 取消一个永不 settle
   * 的 current（handler 等用户输入卡死）时，processNext 的 `await item.handler` 永不 resume，
   * 尾部不会执行；只有 settleItem 里的 processNext 才能打破死锁，推进下一个。
   */
  private settleItem(item: QueueItem, resp: UiResponse): void {
    if (item.settled) return;
    item.settled = true;
    item.resolve(resp);
    // 若是正在处理的项，清空 current/processing 并推进队列（唯一推进点）。
    // 非当前项（队列中被 reject）只 settle Promise，不影响 current/推进。
    if (this.current === item) {
      this.current = undefined;
      this.processing = false;
      void this.processNext();
    }
  }

  /**
   * SR-4：把指定 child 的所有 pending dialog resolve 为 {cancelled:true}。
   *
   * 触发场景：子进程 close（用户取消 / crash / 超时 kill）时，其 pending dialog 的 handler
   * 可能永不 settle（等用户输入），导致 Promise 永挂 + 内存泄漏。本方法批量清理。
   *
   * 处理范围（TC-E4 case 2）：
   *   - 正在处理中（current）的该 child 项：settle {cancelled:true}，解阻塞队列推进下一个
   *     （关键：handler 可能永不 settle，必须由这里打破死锁）
   *   - 队列中等待处理的该 child 项：settle {cancelled:true} 并移除
   *
   * 不影响其他 child 的 pending dialog（TC-E4 case 2 子测试 2）。
   */
  rejectChildDialogs(child: DialogChildRef): void {
    // 先处理正在处理的项（可能永不 settle，必须由这里解阻塞）
    if (this.current && this.current.childPid === child.pid) {
      this.settleItem(this.current, { cancelled: true });
    }
    // 再处理队列中等待的项
    if (this.queue.length === 0) return;
    const remaining: QueueItem[] = [];
    for (const item of this.queue) {
      if (item.childPid === child.pid) {
        // settle 该 child 的 pending Promise 为 cancelled
        this.settleItem(item, { cancelled: true });
      } else {
        remaining.push(item);
      }
    }
    this.queue = remaining;
  }

  /**
   * 处理队列下一项（FIFO）。
   *
   * processing 标志保证串行：handler 运行期间 processing=true，新的 processNext 调用直接返回；
   * handler settle 后由 settleItem 清 processing=false 并推进下一项（#19 单一推进点）。
   *
   * handler 抛错兜底（TC-E4 case 3）：catch → settle {cancelled:true} → 继续。
   * 不能让一个失败卡死队列（processing 永远 true）。
   */
  private async processNext(): Promise<void> {
    if (this.processing) return;
    if (this.queue.length === 0) return;
    this.processing = true;
    const item = this.queue.shift()!;
    this.current = item;
    try {
      const resp = await item.handler(item.req);
      // handler 完成：settle（若已被 rejectChildDialogs 抢先 settle 则 noop）。
      // settleItem 内会清 current/processing 并推进队列（#19 单一推进点）。
      this.settleItem(item, resp);
    } catch {
      // handler 抛错兜底：回 cancelled，不向上抛（队列不能卡死）
      this.settleItem(item, { cancelled: true });
    }
    // #19：不在尾部再调 processNext——推进统一由 settleItem 负责（避免双重推进）。
  }

  /**
   * #10：把所有 pending dialog（queue + current）全部 settle 为 {cancelled:true}，
   * 并清空 queue/current/processing 状态。session_shutdown 调用，保证不留永挂 Promise。
   *
   * 约定签名：rejectAll(): void（无参，返 void）。Group C 的 index.ts session_shutdown 依赖此契约。
   *
   * 幂等：依赖 settleItem 的 settled 标志——重复调用只会对已 settled 项 noop。
   * 顺序敏感（#19 推进点在 settleItem）：必须先清空 queue 数组再 settle current，
   * 否则 settleItem(current) 同步触发的 processNext 会从旧 queue 抢占下一项作为新 current，
   * 避开本方法的 cancel 语义。清空后 processNext 看到空队列直接返回，新 current 不会被抢占。
   *
   * 单 session 假设（M-2）：见类注释。本方法清空所有 pending 不分 session——依赖 Pi 单进程
   * 单 session 串行保证。session_shutdown handler（index.ts）调用本方法时，进程内只会有当前
   * session 的 pending dialog。多 session 并发场景的迁移策略（rejectAllForSession）见类注释。
   */
  rejectAll(): void {
    // 先捕获并清空队列——防 settleItem(current) 触发的 processNext 抢占同队列下一项
    const items = this.queue;
    this.queue = [];
    // 再 settle current（processNext 此时看到空队列，不会抢占）
    if (this.current) {
      this.settleItem(this.current, { cancelled: true });
    }
    // settle 所有原队列项（Promise 必须 resolve，不能挂）
    for (const item of items) {
      this.settleItem(item, { cancelled: true });
    }
    // 状态清理（幂等：settleItem(current) 可能已清）
    this.current = undefined;
    this.processing = false;
  }

  /** 清空队列（dispose 用）。pending 项的 Promise 不 settle（dispose 时调用方已不关心）。
   *  如需 settle，dispose 前应先 rejectChildDialogs 或 rejectAll。 */
  clear(): void {
    this.queue = [];
    this.current = undefined;
    this.processing = false;
  }

  /** 当前队列长度（测试/诊断用）。含等待处理项（不含 current）。 */
  get size(): number {
    return this.queue.length;
  }
}
