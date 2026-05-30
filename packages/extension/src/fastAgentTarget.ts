// Pure, vscode-free helpers for choosing Fast Agent target file names. Kept in
// their own module so they can be unit-tested without the vscode host.

export function normalizeWorkspacePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.?\//u, "");
}

export function isFastAgentEditablePath(path: string): boolean {
  return /\.(c|cfg|cjs|clj|cpp|cs|css|dart|erl|ex|go|h|hpp|html|ini|java|js|json|jsx|jl|kt|lua|md|mjs|php|pl|py|r|rb|rs|scala|sh|sql|svelte|swift|toml|ts|tsx|txt|vue|xml|yaml|yml|zig)$/u.test(path);
}

// When Fast Agent has no mentioned file and the task asks to create something
// new, pick a sensible target filename. Honors an explicit filename in the
// request, then falls back to a language-appropriate default.
export function inferFastAgentNewFileTarget(rawTask: string): string | undefined {
  const normalized = rawTask.toLowerCase();
  if (!/\b(create|build|make|generate|scaffold|new|implement|write)\b/u.test(normalized)) {
    return undefined;
  }
  // Honor a filename the user states explicitly (e.g. "create snake.py").
  const explicit = extractExplicitFilename(rawTask);
  if (explicit !== undefined) {
    return explicit;
  }
  // Otherwise pick a default filename for the requested language/format. Check
  // language before the web/game fallback so "snake game in python" -> main.py,
  // not index.html.
  return inferDefaultFilenameByLanguage(normalized);
}

export function extractExplicitFilename(rawTask: string): string | undefined {
  const tokens = rawTask.match(/[\w./-]+\.[A-Za-z0-9]+/gu);
  if (tokens === null) {
    return undefined;
  }
  const candidate = tokens.find((token) => isFastAgentEditablePath(token.toLowerCase()));
  return candidate === undefined ? undefined : normalizeWorkspacePath(candidate);
}

function inferDefaultFilenameByLanguage(normalized: string): string {
  if (/\breadme\b/u.test(normalized)) {
    return "README.md";
  }
  if (/\b(python|py|flask|django|pygame)\b/u.test(normalized)) {
    return "main.py";
  }
  if (/\b(typescript|tsx?)\b/u.test(normalized)) {
    return "index.ts";
  }
  if (/\b(node|nodejs|javascript|js)\b/u.test(normalized)) {
    return "index.js";
  }
  if (/\b(rust|cargo)\b/u.test(normalized)) {
    return "main.rs";
  }
  if (/\b(golang|go)\b/u.test(normalized)) {
    return "main.go";
  }
  if (/\bjava\b/u.test(normalized)) {
    return "Main.java";
  }
  if (/\b(c\+\+|cpp)\b/u.test(normalized)) {
    return "main.cpp";
  }
  if (/\b(json|config)\b/u.test(normalized)) {
    return "config.json";
  }
  if (/\b(markdown|doc|documentation)\b/u.test(normalized)) {
    return "notes.md";
  }
  // Web/canvas/html/page requests and the generic fallback.
  return "index.html";
}
