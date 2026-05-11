# Project Summary

Buildr is a TypeScript monorepo for a local-model-first VS Code coding agent.

- `packages/core`: shared orchestration contracts, provider adapters, tools, permissions, patch safety, and verification.
- `packages/extension`: VS Code activation, command contributions, workspace trust behavior, and Step Panel UI.
- `packages/cli`: terminal entry point over the shared core.
