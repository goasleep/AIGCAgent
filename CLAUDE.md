# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

OpenCode is an open-source AI coding agent. It's a monorepo with a Bun-based TypeScript backend (using the Effect library), SolidJS web/desktop UIs, and a terminal UI (TUI) built with opentui. The core product is a CLI tool (`opencode`) that provides an AI-powered coding assistant with both interactive TUI and headless server modes.

## Development Environment

- **Package Manager**: Bun 1.3.14+ (required). Do not use npm/pnpm/yarn.
- **Type Checker**: `tsgo` (not `tsc`). Always run `bun typecheck` from package directories, never `tsc` directly.
- **Linter**: oxlint (config in `.oxlintrc.json`)
- **Default Branch**: `dev` (not `main`). Use `dev` or `origin/dev` for diffs.
- **Tests**: Cannot run from repo root (guard: `do-not-run-tests-from-root`). Run from package dirs.

## Common Commands

### Development

```bash
# Install dependencies
bun install

# Run the CLI in development (TUI mode in packages/opencode)
bun dev

# Run against a different directory
bun dev <directory>

# Run in the repo root itself
bun dev .

# Start headless API server
bun dev serve
bun dev serve --port 8080

# Start server + open web interface
bun dev web

# Run the web app (requires server running first)
bun run --cwd packages/app dev

# Run the desktop app (Electron wrapper around web UI)
bun run --cwd packages/desktop dev

# Run the console app (Cloudflare-hosted web console)
bun run --cwd packages/console/app dev
```

### Building

```bash
# Compile standalone executable ("localcode")
./packages/opencode/script/build.ts --single

# Build desktop app
bun run --cwd packages/desktop build
bun run --cwd packages/desktop package

# Build web UI (embedded in binary)
bun run --cwd packages/app build
```

### Testing

```bash
# Run tests in a specific package
bun run --cwd packages/opencode test
bun run --cwd packages/core test
bun run --cwd packages/app test:unit
bun run --cwd packages/app test:browser
bun run --cwd packages/app test:e2e

# Run a single test file
bun test --cwd packages/opencode src/some/file.test.ts

# HTTP API exercise tests
bun run --cwd packages/opencode test:httpapi
```

### Type Checking

```bash
# Typecheck all packages via turbo
bun typecheck

# Typecheck a specific package
bun run --cwd packages/opencode typecheck
bun run --cwd packages/core typecheck
```

### Linting

```bash
bun lint
```

### Code Generation

```bash
# After changing public Protocol or Server HttpApi, regenerate SDK
bun run generate  # from packages/client

# Regenerate legacy JavaScript SDK
./packages/sdk/js/script/build.ts

# Generate schema files for console
./packages/opencode/script/schema.ts
```

## Architecture

### Package Structure

The monorepo uses Bun workspaces. Key packages:

| Package | Path | Purpose |
|---------|------|---------|
| `opencode` | `packages/opencode` | **Main CLI entry point** — server, CLI commands, session orchestration, TUI worker |
| `@opencode-ai/core` | `packages/core` | Shared business logic — database, sessions, projects, providers, tools, Effect services |
| `@opencode-ai/tui` | `packages/tui` | Terminal UI components — SolidJS-based TUI using opentui |
| `@opencode-ai/app` | `packages/app` | Shared web UI components — SolidJS web app |
| `@opencode-ai/desktop` | `packages/desktop` | Electron desktop app wrapper |
| `@opencode-ai/ui` | `packages/ui` | Shared UI component library |
| `@opencode-ai/server` | `packages/server` | HTTP server middleware, routes, auth, CORS |
| `@opencode-ai/client` | `packages/client` | Auto-generated API client from HTTP API |
| `@opencode-ai/sdk-next` | `packages/sdk-next` | Programmatic SDK for embedding OpenCode |
| `@opencode-ai/plugin` | `packages/plugin` | Public plugin API (`@opencode-ai/plugin` on npm) |
| `@opencode-ai/schema` | `packages/schema` | Shared Effect schemas |
| `@opencode-ai/protocol` | `packages/protocol` | HTTP API definitions |
| `@opencode-ai/llm` | `packages/llm` | LLM provider routing and protocol handling |
| `@opencode-ai/console-*` | `packages/console/*` | Cloud-hosted web console (SaaS) |

### Dependency Direction

Runtime dependencies must flow:
- `schema` → `core`, `protocol`
- `core`, `protocol` → `server`
- `client` may depend on `schema`, `protocol` but **never** `core` or `server`
- `sdk-next` composes `client`, `core`, and `server`

### Core Architecture

**Effect-based services**: The codebase heavily uses the Effect library for dependency injection, error handling, and concurrency. Services are defined as `Context.Service` classes with `Layer` implementations. The `LayerNode` pattern from `@opencode-ai/core/effect/layer-node` is used to build service dependency graphs.

**Instance-scoped state**: Most opencode services are scoped to a project instance (directory). `InstanceState` (`packages/opencode/src/effect/instance-state.ts`) provides a per-directory cache. `InstanceRef` is a Context reference carrying the current `InstanceContext` (directory, worktree, project info).

**Server architecture** (`packages/opencode/src/server/`):
- Entry: `server.ts` — creates an Effect HTTP server with WebSocket support
- Routes: `routes/instance/httpapi/` — HTTP API groups (session, project, provider, config, etc.)
- API definition: `routes/instance/httpapi/api.ts` — composes all API groups
- Public API: `routes/instance/httpapi/public.ts` — OpenAPI spec generation
- The server loads instances per-request via `x-opencode-directory` header

**Session architecture** (`packages/opencode/src/session/`):
- `session.ts` — Session manager (create, list, delete, continue)
- `prompt.ts` — Main prompt orchestration (system prompts, tool resolution, LLM streaming)
- `llm.ts` — LLM streaming wrapper around ai-sdk
- `processor.ts` — Tool call processing loop
- `tools.ts` — Tool resolution (built-in + MCP + plugin tools)
- `message-v2.ts` — Message formatting for V2 API
- `compaction.ts` — Session history compaction
- `revert.ts` — Session revert/snapshot management

**CLI commands** (`packages/opencode/src/cli/cmd/`):
- `run.ts` — Main `opencode run` / `opencode --mini` entry
- `tui.ts` — TUI mode (spawns worker thread with server)
- `serve.ts` — Headless server mode
- `web.ts` — Server + web UI
- `session.ts` — Session management (list, delete)
- `db.ts` — SQLite database access
- `agent.ts` — Agent creation/management
- `plug.ts` — Plugin installation
- `mcp.ts` — MCP server management
- `acp.ts` — ACP (Agent Client Protocol) server
- `pr.ts` — GitHub PR checkout
- `debug/` — Debugging tools (config, LSP, file, skill, snapshot, startup)

**TUI** (`packages/tui/src/`):
- Built with SolidJS + opentui (terminal UI framework)
- `runtime.tsx` — Main TUI runtime loop
- `app.tsx` — Root app component
- `prompt/` — Prompt input handling
- `feature-plugins/` — Built-in TUI feature plugins
- Communicates with server via WebWorker RPC (`packages/opencode/src/cli/tui/worker.ts`)

### Database

SQLite via Drizzle ORM. Database path: `~/.opencode/data/db.sqlite` (or platform equivalent). Key tables defined in `packages/core/src/*/sql.ts` files. The `packages/opencode` package uses a `#db` import condition (`bun` vs `node`) for platform-specific database access.

### Configuration

Config is loaded from:
- `~/.opencode/config.json` (global)
- `.opencode/config.json` (project-local, merged with global)
- Managed via `opencode config` command or `Config` service

### Plugin System

Plugins are npm packages that export hooks. The public API is in `packages/plugin/src/`. Plugins can provide:
- Tools (`tool` export)
- TUI components (`tui` export)
- Auth methods (`auth` export)
- Skills (`skill` export)

Install with `opencode plug <package>`.

### MCP Integration

Model Context Protocol servers are configured in `~/.opencode/config.json` under `mcp`. The `MCP` service (`packages/opencode/src/mcp/`) manages stdio, SSE, and HTTP transports with OAuth support.

### Agent System

Agents are YAML files defining permissions, model, prompts, and mode. Built-in agents:
- `build` (default) — full-access agent
- `plan` — read-only agent for exploration

Custom agents can be created with `opencode agent create`.

## Style Guide (from AGENTS.md)

- Keep logic in one function unless composable/reusable
- Avoid `try`/`catch` where possible; prefer `.catch(...)`
- Avoid `any` type; use precise types
- Use Bun APIs when possible (`Bun.file()`)
- Rely on type inference; avoid explicit annotations unless needed for exports
- Prefer functional array methods over for loops
- Prefer `const` over `let`; use ternaries or early returns instead of reassignment
- Avoid `else` statements; prefer early returns
- Never alias imports (`import { foo as bar }`)
- Never use star imports (`import * as Foo`)
- Use snake_case for Drizzle schema field names
- In Effect generators, bind services to named variables before calling methods
- Reduce variable count by inlining when a value is only used once

## Testing Guidelines

- Avoid mocks; don't use `globalThis.*` unless it's the only option
- Test actual implementation, don't duplicate logic into tests
- Tests must run from package directories, not root

## Debugging

```bash
# Debug with Bun inspector (most reliable)
bun run --inspect=ws://localhost:6499/ dev ...

# Debug server separately
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096

# Debug TUI separately
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts

# Use spawn mode for server breakpoints in TUI
bun dev spawn
```

## Important Notes

- The `dev` script runs the TUI by default. The `serve` subcommand starts headless mode.
- `bun dev` is the local equivalent of the built `opencode` command.
- After API/SDK changes, run `./script/generate.ts` to regenerate the SDK.
- Branch names: short, max 3 words, hyphen-separated. No `feat/` or `fix/` prefixes.
- PR titles: conventional commits (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`)
