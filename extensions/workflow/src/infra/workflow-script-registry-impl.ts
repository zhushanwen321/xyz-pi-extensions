/**
 * Workflow Extension — WorkflowScriptRegistryImpl
 *
 * WorkflowScriptRegistry port 的 Infra 实现。
 *
 * 职责：扫描 .pi/workflows/ + ~/.pi/agent/workflows/ 目录，按 regex 提取
 * meta（不执行用户代码），按 tmp>project>user 优先级去重，60s TTL 缓存。
 *
 * 层归属：Infra（D-12）。implements Engine 层的 WorkflowScriptRegistry port。
 *
 * 设计：
 * - WorkflowScriptRegistryImpl 是 port 的实现，但底层扫描/缓存/去重仍委托
 * config-loader.ts 的 loadWorkflows/getWorkflow/invalidateCache 自由函数
 * （config-loader 是稳定 Infra 工具，registry 在其上包装为 WorkflowScript 实体）。
 * - 返回 WorkflowScript 实体（而非裸 CachedWorkflowMeta）。
 * - get(name) 精确匹配；fuzzy 匹配由 Interface 层 tool 负责。
 */

import { readFileSync } from "node:fs";

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
 * 按名查单个脚本。精确匹配。
 * 返回 undefined 当 name 不存在。
 *
 * 注：fuzzy 匹配由 Interface 层 tool-workflow负责——registry 只做精确查。
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
 * 把 CachedWorkflowMeta 转换为 WorkflowScript 实体。
 *
 * 字段映射：
 * - name/path/source 直接传
 * - meta 拆为 WorkflowMeta（name/description/phases）
 * - sourceCode 在此 readFile 填充（FR-2：registry 是唯一读文件处，扫描+缓存+去重；
 * 60s TTL 缓存避免重复读）。caller（launcher.runAndWait / tool-workflow.actionRun）
 * 直接用 script.validate / script.toExecutable，不再各自 readFile。
 * - available：meta 提取失败（config-loader 标 available=false）或文件不可读时为 false
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
 // FR-2: registry 是唯一读文件处。readFileSync 填 sourceCode —— 这样 launcher/tool
 // 直接调 toExecutable/validate 即可，无需各自 readFile（避免重复读，60s TTL 缓存生效）。
    let sourceCode = "";
    let available = m.available;
    if (available) {
      try {
        sourceCode = readFileSync(m.path, "utf-8");
      } catch {
 // 文件不可读（race condition 删除、权限等）——标 available=false，
 // 与 meta 提取失败的现有语义一致（loader "never throws"）。
        sourceCode = "";
        available = false;
      }
    }
    return new WorkflowScript({
      name: m.name,
      source: m.source,
      path: m.path,
      sourceCode,
      meta,
      available,
    });
  }
}
