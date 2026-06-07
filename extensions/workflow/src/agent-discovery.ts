import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A discovered agent with metadata about where it was found. */
export interface DiscoveredAgent {
  name: string;
  systemPrompt: string;
  model?: string;
  description?: string;
  filePath: string;
  source: "project" | "user" | "package" | "local";
}

/** Parsed frontmatter fields. */
interface FrontmatterResult {
  name: string;
  model?: string;
  description?: string;
  systemPrompt: string;
}

/**
 * Discover .md agent files from multiple search paths with priority ordering.
 *
 * Lower priority paths are scanned first so that higher priority paths can
 * overwrite entries via Map.set — last writer wins.
 */
export class AgentRegistry {
  private readonly cwd: string;
  private readonly homeDir: string;
  private readonly cache = new Map<string, DiscoveredAgent>();

  constructor(cwd: string, homeDir?: string) {
    this.cwd = cwd;
    this.homeDir = homeDir ?? os.homedir();
  }

  /** Scan all discovery paths and populate the internal cache. Clears previous entries first. */
  discoverAll(): void {
    this.cache.clear();

    const home = this.homeDir;

    // Ordered lowest → highest priority. Map.set overwrites, so last writer wins.
    const scanTargets: Array<{ dir: string; source: DiscoveredAgent["source"] }> = [
      // Priority 9 (lowest): extensions/*/agents/*.md
      { dir: path.join(this.cwd, "extensions"), source: "local" },
      // Priority 7-8: cwd/.pi/npm/node_modules/{@scope/pkg,pkg}/agents/*.md
      { dir: path.join(this.cwd, ".pi", "npm", "node_modules"), source: "package" },
      // Priority 5-6: ~/.pi/agent/npm/node_modules/{@scope/pkg,pkg}/agents/*.md
      { dir: path.join(home, ".pi", "agent", "npm", "node_modules"), source: "package" },
      // Priority 4: ~/.agents/agents/*.md
      { dir: path.join(home, ".agents", "agents"), source: "user" },
      // Priority 3: ~/.pi/agent/agents/*.md
      { dir: path.join(home, ".pi", "agent", "agents"), source: "user" },
      // Priority 2: cwd/.agents/agents/*.md
      { dir: path.join(this.cwd, ".agents", "agents"), source: "project" },
      // Priority 1 (highest): cwd/.pi/agents/*.md
      { dir: path.join(this.cwd, ".pi", "agents"), source: "project" },
    ];

    for (const target of scanTargets) {
      if (target.source === "local") {
        // extensions/*/agents/ — iterate extension dirs, then scan their agents/
        this.scanExtensionsDir(target.dir, target.source);
      } else if (target.source === "package") {
        // node_modules — iterate packages, then scan their agents/
        this.scanNpmDir(target.dir, target.source);
      } else {
        // Direct agents/ directory
        this.scanDir(target.dir, target.source);
      }
    }
  }

  /** Look up an agent by name. Returns undefined if not found. */
  resolve(name: string): DiscoveredAgent | undefined {
    return this.cache.get(name);
  }

  /** Return all discovered agents. */
  list(): DiscoveredAgent[] {
    return [...this.cache.values()];
  }

  // ── Internal scanning helpers ──────────────────────────────

  /** Scan an extensions/ directory: each subdirectory's agents/ folder. */
  private scanExtensionsDir(extensionsDir: string, source: DiscoveredAgent["source"]): void {
    if (!this.safeStatDir(extensionsDir)) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(extensionsDir);
    } catch {
      // Directory not readable — skip
      return;
    }

    for (const entry of entries) {
      const agentsDir = path.join(extensionsDir, entry, "agents");
      this.scanDir(agentsDir, source);
    }
  }

  /**
   * Scan an npm node_modules directory: handle both scoped (@scope/pkg)
   * and unscoped (pkg) packages, looking for agents/ subdirectory in each.
   */
  private scanNpmDir(nodeModulesDir: string, source: DiscoveredAgent["source"]): void {
    if (!this.safeStatDir(nodeModulesDir)) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(nodeModulesDir);
    } catch {
      // node_modules not readable — skip
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(nodeModulesDir, entry);
      if (entry.startsWith("@")) {
        // Scoped package directory — iterate children
        let scopedEntries: string[];
        try {
          scopedEntries = fs.readdirSync(entryPath);
        } catch {
          // Scoped directory not readable — skip
          continue;
        }
        for (const scopedPkg of scopedEntries) {
          const agentsDir = path.join(entryPath, scopedPkg, "agents");
          this.scanDir(agentsDir, source);
        }
      } else {
        // Unscoped package
        const agentsDir = path.join(entryPath, "agents");
        this.scanDir(agentsDir, source);
      }
    }
  }

  /** Scan a single directory for .md agent files. */
  private scanDir(dir: string, source: DiscoveredAgent["source"]): void {
    if (!this.safeStatDir(dir)) return;

    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      // Agents directory not readable — skip
      return;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (entry.startsWith("_")) continue;
      if (entry.endsWith(".chain.md")) continue;

      const filePath = path.join(dir, entry);
      this.processFile(filePath, entry, source);
    }
  }

  /** Read and parse a single .md agent file, adding it to the cache. */
  private processFile(filePath: string, fileName: string, source: DiscoveredAgent["source"]): void {
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      // File not readable — skip
      return;
    }

    const parsed = parseFrontmatter(content, fileName);
    this.cache.set(parsed.name, {
      name: parsed.name,
      systemPrompt: parsed.systemPrompt,
      model: parsed.model,
      description: parsed.description,
      filePath,
      source,
    });
  }

  /** Check if a path exists and is a directory. Returns false on any error. */
  private safeStatDir(dirPath: string): boolean {
    try {
      return fs.statSync(dirPath).isDirectory();
    } catch {
      // Path doesn't exist or not accessible — skip
      return false;
    }
  }
}

// ── Frontmatter parsing ─────────────────────────────────────

/**
 * Parse a .md file's frontmatter and body.
 *
 * - If file starts with `---`, look for closing `---`. If found, extract YAML
 *   fields via regex and use the rest as systemPrompt. If not found, treat
 *   entire file as systemPrompt with filename as name.
 * - If no frontmatter, filename (minus .md) is name, entire content is systemPrompt.
 *
 * Limitation: uses simple indexOf to find the closing `---`, so YAML field values
 * containing `---` on its own line would cause premature truncation. Acceptable
 * for Pi agent files where frontmatter only contains simple key: value pairs.
 */
function parseFrontmatter(content: string, fileName: string): FrontmatterResult {
  const baseName = fileName.replace(/\.md$/, "");
  // Length of the opening "---" delimiter plus the newline that follows it
  const FM_DELIM_LEN = "---".length;

  if (!content.startsWith("---")) {
    return { name: baseName, systemPrompt: content.trim() };
  }

  // Look for closing ---, starting after the opening delimiter
  const closeIdx = content.indexOf("---", FM_DELIM_LEN);

  // Unclosed frontmatter — entire file as systemPrompt, filename as name
  if (closeIdx === -1) {
    return { name: baseName, systemPrompt: content.trim() };
  }

  const yamlBlock = content.slice(FM_DELIM_LEN, closeIdx);
  const body = content.slice(closeIdx + FM_DELIM_LEN).trim();

  const name = extractYamlField(yamlBlock, "name") || baseName;
  const model = extractYamlField(yamlBlock, "model");
  const description = extractYamlField(yamlBlock, "description");

  return {
    name,
    model: model || undefined,
    description: description || undefined,
    systemPrompt: body,
  };
}

/** Extract a simple `key: value` field from YAML text. Strips surrounding quotes. */
function extractYamlField(yaml: string, key: string): string | null {
  // Match `key: value` — value may be quoted with double quotes
  const regex = new RegExp(`^${key}:\\s*(.+)$`, "m");
  const match = yaml.match(regex);
  if (!match) return null;

  let value = match[1].trim();
  // Strip surrounding quotes (double or single)
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value || null;
}

