import * as fs from "node:fs";
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

export function listTemplates(projectDir?: string): TemplateInfo[] {
  const templates: TemplateInfo[] = [];
  const seen = new Set<string>();

  // 1. Project-level templates (highest priority)
  if (projectDir) {
    const projectTemplateDir = path.join(projectDir, ".pi", "plan-templates");
    if (fs.existsSync(projectTemplateDir)) {
      for (const file of fs.readdirSync(projectTemplateDir)) {
        if (file.endsWith(".md")) {
          const name = file.replace(/\.md$/, "");
          templates.push({ name, source: "project", path: path.join(projectTemplateDir, file) });
          seen.add(name);
        }
      }
    }
  }

  // 2. Global templates
  const globalTemplateDir = path.join(process.env.HOME || "", ".pi", "agent", "plan-templates");
  if (fs.existsSync(globalTemplateDir)) {
    for (const file of fs.readdirSync(globalTemplateDir)) {
      if (file.endsWith(".md")) {
        const name = file.replace(/\.md$/, "");
        if (!seen.has(name)) {
          templates.push({ name, source: "global", path: path.join(globalTemplateDir, file) });
          seen.add(name);
        }
      }
    }
  }

  // 3. Builtin templates (lowest priority)
  const builtinDir = getBuiltinTemplateDir();
  if (fs.existsSync(builtinDir)) {
    for (const file of fs.readdirSync(builtinDir)) {
      if (file.endsWith(".md")) {
        const name = file.replace(/\.md$/, "");
        if (!seen.has(name)) {
          templates.push({ name, source: "builtin", path: path.join(builtinDir, file) });
        }
      }
    }
  }

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
