import { relative } from "node:path";

export interface ScopeFidelityResult {
  ok: boolean;
  checkedFiles: string[];
  outOfScopeFiles: string[];
  warnings: string[];
}

export function checkScopeFidelity(options: {
  workspaceRoot: string;
  approvedTargets: string[];
  changedFiles: string[];
}): ScopeFidelityResult {
  const approvedTargets = options.approvedTargets.filter((target) => !target.includes("${") && !target.includes(" "));
  if (approvedTargets.length === 0) {
    return {
      ok: true,
      checkedFiles: options.changedFiles,
      outOfScopeFiles: [],
      warnings: ["No concrete approved targets were provided; scope check was informational only."]
    };
  }

  const outOfScopeFiles = options.changedFiles.filter((file) => {
    const relativePath = normalizePath(relative(options.workspaceRoot, file));
    return !approvedTargets.some((target) => matchesTarget(relativePath, normalizePath(target)));
  });

  return {
    ok: outOfScopeFiles.length === 0,
    checkedFiles: options.changedFiles,
    outOfScopeFiles,
    warnings: outOfScopeFiles.map((file) => `Changed file is outside approved targets: ${file}`)
  };
}

function matchesTarget(relativePath: string, target: string): boolean {
  if (target.endsWith("/**")) {
    return relativePath.startsWith(target.slice(0, -3));
  }
  if (target.endsWith("/*")) {
    const prefix = target.slice(0, -1);
    return relativePath.startsWith(prefix) && !relativePath.slice(prefix.length).includes("/");
  }
  return relativePath === target || relativePath.startsWith(`${target}/`);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}
