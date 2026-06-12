import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface TemplateInfo {
  name: string;
  source: "builtin" | "global" | "project";
  path: string;
}

export function getBuiltinTemplateDir(): string {
  return path.resolve(__dirname, "..", "templates");
}

function scanTemplateDir(dir: string, source: TemplateInfo["source"], seen: Set<string>): TemplateInfo[] {
  const results: TemplateInfo[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith(".md")) {
      const name = file.replace(/\.md$/, "");
      if (!seen.has(name)) {
        results.push({ name, source, path: path.join(dir, file) });
        seen.add(name);
      }
    }
  }
  return results;
}

export function listTemplates(projectDir?: string): TemplateInfo[] {
  const seen = new Set<string>();
  const templates: TemplateInfo[] = [];

  // 1. Project-level templates (highest priority)
  if (projectDir) {
    templates.push(...scanTemplateDir(path.join(projectDir, ".pi", "plan-templates"), "project", seen));
  }

  // 2. Global templates
  templates.push(...scanTemplateDir(path.join(os.homedir(), ".pi", "agent", "plan-templates"), "global", seen));

  // 3. Builtin templates (lowest priority)
  templates.push(...scanTemplateDir(getBuiltinTemplateDir(), "builtin", seen));

  return templates;
}

export function loadTemplate(name: string, projectDir?: string): string | null {
  const templates = listTemplates(projectDir);
  const template = templates.find((t) => t.name === name);
  if (!template) return null;

  try {
    return fs.readFileSync(template.path, "utf-8");
  } catch {
    return null;
  }
}
