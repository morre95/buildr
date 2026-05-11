# Buildr

Buildr is a local-model-first VS Code agent for transparent coding workflows.

The first implementation milestone is a narrow vertical slice:

- VS Code extension activation and command palette commands.
- Shared TypeScript core used by the extension and CLI.
- Ollama as the first local provider.
- Validated plan objects with scope boundaries and verification contracts.
- Diff-first text patch proposals with explicit permission decisions.
- Basic verification evidence from diagnostics or approved commands.

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
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
  extension/ VS Code extension entry point and Step Panel scaffold.
  cli/        Terminal entry point over the shared core.
```
