import * as vscode from "vscode";

export interface DiagnosticsSummary {
  count: number;
  files: string[];
  message: string;
}

export function readDiagnosticsSummary(): DiagnosticsSummary {
  const diagnostics = vscode.languages.getDiagnostics();
  const files = diagnostics.filter(([, items]) => items.length > 0).map(([uri]) => uri.fsPath);
  const count = diagnostics.reduce((total, [, items]) => total + items.length, 0);
  return {
    count,
    files,
    message: count === 0 ? "No diagnostics reported." : `${count} diagnostic(s) across ${files.length} file(s).`
  };
}
