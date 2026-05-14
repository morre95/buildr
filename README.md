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

Run to create vscode extention file:
```bash
pnpm --filter buildr-vscode package
```

Run extention:
```bash
code --install-extension path/to/your-extension.vsix   
```

## Multi-Agent Workflow

Buildr agent mode can launch parallel sub-agents from the main agent session. Sub-agents propose patches for plan write targets, then the main agent gathers those results and routes each patch through the normal approval flow before anything is applied.

### VS Code

1. Build the repo if needed:

   ```bash
   pnpm build
   # create extenbionb file
   pnpm --filter buildr-vscode package
   # Run extention
   code --install-extension path/to/your-extension.vsix 
   ```

2. Open the Buildr extension in VS Code.
3. Run **Buildr: Open Chat** from the command palette.
4. Select **Agent** mode in the chat panel.
5. Enter a task that requires file changes.
6. Review the generated plan and approve or deny each proposed patch.

Useful settings are available through **Buildr: Open Settings**:

- **Max parallel sub-agents** controls parallel fan-out.
- **Hard token cap** blocks before a model call would exceed the session token cap.
- **Token warning thresholds** emits budget warnings, for example at 70% and 90%.
- **Input token cost** and **Output token cost** estimate real-time USD cost per million tokens. Local providers default to zero cost.

### CLI

The CLI can run the same shared multi-agent session for model-backed runs and report sub-agent summaries, token usage, budget warnings, and estimated cost. It does not apply patches.

```bash
pnpm --filter buildr-agent buildr run \
  --model qwen/qwen3-coder-30b \
  --hard-token-cap 32000 \
  --max-parallel-sub-agents 3 \
  "your task here"
```

Optional cost flags:

```bash
--input-usd-per-million 0
--output-usd-per-million 0
```

## Repo Layout

```text
packages/
  core/       Shared agent contracts, provider adapters, tools, permissions, verification.
  extension/ VS Code extension entry point, native commands, settings, and Step Panel.
  cli/        Terminal entry point over the shared core.
```
