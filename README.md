# Buildr

Buildr is a local-model-first VS Code agent for transparent coding workflows.

Current implementation milestones cover the runnable slice, security hardening, native VS Code context features, MCP/debug support, and CLI polish:

- VS Code extension activation and command palette commands.
- Shared TypeScript core used by the extension and CLI.
- Ollama as the first local provider.
- Validated plan objects with scope boundaries and verification contracts.
- Diff-first text patch proposals with explicit permission decisions.
- Basic verification evidence from diagnostics or approved commands.
- MCP config discovery, doctor output, and Debug Mode hypotheses.
- CLI commands for `plan`, `run`, `debug`, `context`, `index`, `mcp list`, and `doctor`.
- Local and provider-backed embeddings adapters for semantic context ranking.

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm package:extension
```

The extension VSIX is produced with `vsce package --no-dependencies` after an **esbuild** bundle of `dist/extension.js` into `dist/extension.bundled.js`, so packaging works with **pnpm** (avoids `npm list` + symlink issues with workspace deps and heavy optional trees such as `@huggingface/transformers`).

Run ro create vscode extention file:
```bash
pnpm --filter buildr-vscode package
```

If `pnpm` is not on PATH, use Corepack:

```bash
corepack pnpm install
corepack pnpm build
```

## Repo Layout

```text
packages/
  core/       Shared agent contracts, provider adapters, tools, permissions, verification.
  extension/ VS Code extension entry point, native commands, settings, and Step Panel.
  cli/        Terminal entry point over the shared core.
```
