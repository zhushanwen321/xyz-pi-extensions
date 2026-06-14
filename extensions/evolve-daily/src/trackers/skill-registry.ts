/**
 * Skill 名称注册表 — 用于 use_skill(start) 的 name 校验。
 *
 * Extension 拿不到 Pi 的 resourceLoader.getSkills()，通过独立扫描
 * 已知 skills 目录 + system prompt fallback 实现。
 */

import { homedir } from "node:os";
import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

const NPM_SKILLS_GLOB_ROOT = join(
  homedir(),
  ".pi/agent/npm/node_modules",
);

/** 扫描用户级 skills 目录（直接子目录 = skill name） */
function scanDirectChildren(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((name) => {
      const fullPath = join(dir, name);
      return statSync(fullPath).isDirectory();
    });
  } catch {
    return [];
  }
}

/** 扫描 npm bundled skills：处理两种 npm 目录结构
 *  - unscoped: node_modules/{pkg}/skills/*
 *  - scoped:   node_modules/@{scope}/{pkg}/skills/*
 */
function scanNpmBundledSkills(): string[] {
  if (!existsSync(NPM_SKILLS_GLOB_ROOT)) return [];
  const names: string[] = [];
  try {
    for (const entry of readdirSync(NPM_SKILLS_GLOB_ROOT)) {
      const entryPath = join(NPM_SKILLS_GLOB_ROOT, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      if (entry.startsWith("@")) {
        // scoped package：@scope 下每个子包可能有 skills
        for (const subPkg of readdirSync(entryPath)) {
          const scopedSkillsDir = join(entryPath, subPkg, "skills");
          if (existsSync(scopedSkillsDir) && statSync(scopedSkillsDir).isDirectory()) {
            names.push(...scanDirectChildren(scopedSkillsDir));
          }
        }
      } else {
        // unscoped package：直接在包下找 skills
        const skillsDir = join(entryPath, "skills");
        if (existsSync(skillsDir) && statSync(skillsDir).isDirectory()) {
          names.push(...scanDirectChildren(skillsDir));
        }
      }
    }
  } catch {
    // 扫描失败，静默返回空（system prompt fallback 会兜底）
  }
  return names;
}

/** 从 system prompt 正则提取 skill 名称（fallback） */
function extractFromSystemPrompt(systemPrompt: string): string[] {
  const matches = systemPrompt.matchAll(/<name>([^<]+)<\/name>/g);
  return Array.from(matches, (m) => m[1].trim());
}

/**
 * 扫描已知 skills 目录，返回合法 skill 名称集合。
 * system prompt 作为补充来源（不限于目录扫描零命中）——
 * 目录扫描可能因路径变化、新增 extension 格式等遗漏，system prompt 始终兜底。
 */
export function scanSkillNames(
  systemPrompt?: string,
): Set<string> {
  const dirs = [
    join(homedir(), ".pi/agent/skills"),
    join(process.cwd(), ".agents/skills"),
  ];

  const names = new Set<string>();
  for (const dir of dirs) {
    for (const name of scanDirectChildren(dir)) {
      names.add(name);
    }
  }
  for (const name of scanNpmBundledSkills()) {
    names.add(name);
  }

  // 补充：从 system prompt 提取（始终执行，不限于目录扫描零命中）
  if (systemPrompt) {
    for (const name of extractFromSystemPrompt(systemPrompt)) {
      names.add(name);
    }
  }

  return names;
}

/**
 * 校验 skill 名称是否合法。
 * 先查缓存的目录扫描结果；无缓存时实时扫描。
 */
export function isValidSkillName(
  name: string,
  systemPrompt?: string,
): boolean {
  const knownNames = scanSkillNames(systemPrompt);
  return knownNames.has(name);
}
