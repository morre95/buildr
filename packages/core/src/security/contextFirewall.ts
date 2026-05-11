import { basename } from "node:path";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ContextFirewallDecision {
  allowed: boolean;
  redactedText?: string;
  warnings: string[];
}

export interface ContextFirewallOptions {
  neverSendPaths?: string[];
  redactSecrets?: boolean;
}

const DEFAULT_NEVER_SEND_PATTERNS = [
  ".env",
  ".env.",
  ".npmrc",
  ".pypirc",
  ".pem",
  ".key",
  "id_rsa",
  "id_ed25519",
  "credentials.json",
  "secrets/"
];

const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "generic token assignment", pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*["']?([^\s"']{8,})["']?/giu },
  { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu },
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu }
];

export class ContextFirewall {
  private readonly neverSendPatterns: string[];
  private readonly redactSecrets: boolean;

  constructor(options: ContextFirewallOptions = {}) {
    this.neverSendPatterns = options.neverSendPaths ?? DEFAULT_NEVER_SEND_PATTERNS;
    this.redactSecrets = options.redactSecrets ?? true;
  }

  inspectPath(path: string): ContextFirewallDecision {
    const normalized = path.replaceAll("\\", "/");
    const fileName = basename(normalized);
    const matched = this.neverSendPatterns.find((pattern) => normalized.includes(pattern) || fileName.startsWith(pattern));

    if (matched !== undefined) {
      return {
        allowed: false,
        warnings: [`Path is blocked by context firewall pattern: ${matched}`]
      };
    }

    return {
      allowed: true,
      warnings: []
    };
  }

  inspectText(text: string): ContextFirewallDecision {
    if (!this.redactSecrets) {
      return {
        allowed: true,
        redactedText: text,
        warnings: []
      };
    }

    let redactedText = text;
    const warnings: string[] = [];
    for (const secretPattern of SECRET_PATTERNS) {
      if (secretPattern.pattern.test(redactedText)) {
        warnings.push(`Redacted possible secret: ${secretPattern.name}`);
        redactedText = redactedText.replace(secretPattern.pattern, "[REDACTED_SECRET]");
      }
      secretPattern.pattern.lastIndex = 0;
    }

    return {
      allowed: true,
      redactedText,
      warnings
    };
  }

  inspectFileContext(path: string, text: string): ContextFirewallDecision {
    const pathDecision = this.inspectPath(path);
    if (!pathDecision.allowed) {
      return pathDecision;
    }

    const textDecision = this.inspectText(text);
    return {
      allowed: true,
      warnings: [...pathDecision.warnings, ...textDecision.warnings],
      ...(textDecision.redactedText === undefined ? {} : { redactedText: textDecision.redactedText })
    };
  }
}

export async function createWorkspaceFirewall(root: string): Promise<ContextFirewall> {
  const ignorePatterns = await loadWorkspaceIgnorePatterns(root);
  return new ContextFirewall({
    neverSendPaths: [...DEFAULT_NEVER_SEND_PATTERNS, ...ignorePatterns]
  });
}

async function loadWorkspaceIgnorePatterns(root: string): Promise<string[]> {
  const files = [".gitignore", ".buildrignore"];
  const patterns: string[] = [];
  for (const file of files) {
    try {
      const content = await readFile(join(root, file), "utf8");
      patterns.push(...parseIgnorePatterns(content));
    } catch {
      // Missing ignore files are normal.
    }
  }
  return patterns;
}

function parseIgnorePatterns(content: string): string[] {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/^\//u, "").replace(/\*+$/u, ""));
}
