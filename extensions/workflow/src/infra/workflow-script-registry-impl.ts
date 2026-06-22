/**
 * Workflow Extension — WorkflowScriptRegistryImpl（W2-T14）
 *
 * WorkflowScriptRegistry port 的 Infra 实现（原 infra/config-loader.ts +
 * infra/workflow-files.ts 的扫描/缓存/去重职责）。
 *
 * 职责：扫描 .pi/workflows/ + ~/.pi/agent/workflows/ 目录，按 regex 提取
 * meta（不执行用户代码），按 tmp>project>user 优先级去重，60s TTL 缓存。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 WorkflowScriptRegistry port（T6）。
 *
 * 关键变化（相对旧 infra/config-loader.ts）：
 *   - WorkflowScriptRegistryImpl implements WorkflowScriptRegistry
 *     （而非散落的 loadWorkflows/getWorkflow/invalidateCache 自由函数）
 *   - 返回 WorkflowScript 实体（T6 构造），而非旧 CachedWorkflowMeta
 *   - 缓存/去重/扫描逻辑保留（逐行对照 config-loader.ts）
 *   - get(name) 精确匹配（旧 getWorkflow 行为；fuzzy 匹配由 Interface 层 tool 负责）
 *
 * 过渡期：旧 loadWorkflows/getWorkflow/invalidateCache 仍保留导出（tool-workflow 等
 * 调用方仍依赖；W4 T25 切换到新 registry 后旧函数成死代码，W5 T29 删除）。
 */

import {
  type WorkflowMeta,
  WorkflowScript,
  type WorkflowSource,
} from "../engine/models/workflow-script.js";
import type { WorkflowScriptRegistry } from "../engine/models/workflow-script-registry.js";
import {
  getWorkflow,
  invalidateCache,
  loadWorkflows,
} from "./config-loader.js";

// ── WorkflowScriptRegistryImpl ───────────────────────────────

export class WorkflowScriptRegistryImpl implements WorkflowScriptRegistry {
  /**
   * 扫描所有 workflow 脚本（project + user + tmp），按 tmp>project>user 优先级
   * 去重，返回 WorkflowScript 实体数组（含 available=false 的解析失败项）。
   *
   * 60s TTL 缓存——同 workspace 60s 内重复调用走缓存。
   */
  async loadAll(): Promise<WorkflowScript[]> {
    const metas = await loadWorkflows();
    return metas.map((m) => this.toScript(m));
  }

  /**
   * 按名查单个脚本。精确匹配（旧 getWorkflow 行为）。
   * 返回 undefined 当 name 不存在。
   *
   * 注：fuzzy 匹配由 Interface 层 tool-workflow（T25）负责——registry 只做精确查。
   */
  async get(name: string): Promise<WorkflowScript | undefined> {
    const meta = await getWorkflow(name);
    return meta ? this.toScript(meta) : undefined;
  }

  /** 失效缓存——下次 loadAll/get 重新扫描文件系统。 */
  invalidate(): void {
    invalidateCache();
  }

  /**
   * 把旧 CachedWorkflowMeta 转换为 WorkflowScript 实体（T6 构造）。
   *
   * 字段映射：
   *   - name/path/source/available 直接传
   *   - meta 拆为 WorkflowMeta（name/description/phases）
   *   - sourceCode 这里不预读（lazy）——WorkflowScript.toExecutable() 按需读
   *     实际：旧 config-loader 不读 sourceCode（只 regex 提 meta），WorkflowScript
   *     的 sourceCode 字段对 registry 来说非必需（validate/toExecutable 由 Interface
   *     层按需调用）。此处填空字符串占位——真要 sourceCode 时 Interface 层 readFile。
   */
  private toScript(m: {
    name: string;
    description: string;
    phases: (string | { title: string; detail?: string })[];
    path: string;
    available: boolean;
    source: WorkflowSource;
  }): WorkflowScript {
    const meta: WorkflowMeta = {
      name: m.name,
      description: m.description,
      phases: m.phases,
    };
    return new WorkflowScript({
      name: m.name,
      source: m.source,
      path: m.path,
      // sourceCode 暂留空串——旧 config-loader 不读文件内容（只 regex 提 meta），
      // WorkflowScript.sourceCode 在 registry 场景不需要（Interface 层调用 readFile
      // 按需填充，或 T22 launcher 直接用 spec.scriptSource）。空串不影响 list/get。
      sourceCode: "",
      meta,
      available: m.available,
    });
  }
}
