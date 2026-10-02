# <img src="https://constellationdev.io/clawd-icon.svg" height="30"> Constellation Plugin for Claude Code

[![MCP Server](https://img.shields.io/badge/mcp-@constellationdev/mcp-black.svg?logo=modelcontextprotocol)](https://github.com/ShiftinBits/constellation-mcp) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-3DA639?logo=opensourceinitiative&logoColor=white)](LICENSE)

While Constellation's MCP server provides raw code intelligence capabilities, this plugin enhances your Claude Code experience with:

| Feature | Benefit |
|---------|---------|
| **Slash Commands** | Quick access to common workflows |
| **Contextual Skills** | Claude automatically loads relevant knowledge — including proactive impact analysis before risky changes |
| **Safety Hooks** | Nudges Claude toward `code_intel` over text search at session start, in subagents, and before Grep/Glob/Bash search commands |

## Features

### Commands

Execute powerful analysis with simple slash commands:

| Command | Description |
|---------|-------------|
| `/constellation:status` | Check API connectivity and project indexing status |
| `/constellation:diagnose` | Quick health check for connectivity and authentication |
| `/constellation:impact <symbol> <file>` | Analyze blast radius before changing a symbol |
| `/constellation:deps <file> [--reverse]` | Map dependencies or find what depends on a file |
| `/constellation:unused` | Discover orphaned exports and dead code |
| `/constellation:architecture` | Get a high-level overview of your codebase structure |

### Skills

Claude automatically activates specialized knowledge based on your questions:

| Skill | Triggers When You Ask About... |
|-------|-------------------------------|
| **constellation-troubleshooting** | Error codes, connectivity issues, debugging problems |
| **impact-analysis** | Renaming, refactoring, deleting, or moving symbols/files; "what would break if...", "is X dead code", "what depends on X" |

**Example Trigger:**
```
You: "Rename AuthService to AuthenticationService"
Claude: "Before renaming, let me analyze the potential impact..."
[impact-analysis skill activates, runs api.impactAnalysis, reports risk + dependents]
```

### Hooks

Event hooks enable intelligent, transparent assistance:

| Hook | Event (matcher) | Behavior |
|------|-----------------|----------|
| **Session Awareness** | `SessionStart` | Injects `code_intel` MCP tool awareness at session start |
| **Subagent Awareness** | `SubagentStart` | Injects `code_intel` awareness into spawned subagents (built-ins like Explore/Plan don't inherit project AGENTS.md) |
| **Search Tool Nudge** | `PreToolUse` (`Grep\|Glob`) | Reminds Claude to prefer `code_intel` over Grep/Glob for structural queries |
| **Bash Search Nudge** | `PreToolUse` (`Bash`) | Inspects the command and emits the same reminder when it starts with `grep`/`rg`/`glob`/`awk`/`findstr` |

All hooks are gated on `CONSTELLATION_ACCESS_KEY` being set (no key → silent no-op, so the plugin doesn't nag in environments where Constellation isn't configured).

### Mods

Alongside the settings hooks above, the plugin ships a hooks module (`hooks/register.ts`) that Claude Code loads and runs in-process, in the same session, instead of starting a separate `node` process per event. The module makes no network requests and spawns no processes. It uses only the Claude Code calls listed under [Data Handling](#data-handling), and it queries the same `code_intel` MCP server the commands use.

- **Version floor:** Claude Code 2.1.287. Older builds are expected to ignore the module and keep running the settings hooks.
- **Turn it off:** disable the plugin from `/plugin`, start Claude Code with `--safe-mode`, or set `disableAllHooks` in your settings.

## Data Handling

What the plugin runs, reads, and sends:

| Component | Runs / reads | Sends |
|-----------|--------------|-------|
| **MCP server** | Started with `npx -y @constellationdev/mcp@<pinned version>`, which downloads the package from the npm registry. Reads `constellation.json` and the current git branch from your project, and reads lines from local source files to attach code snippets to query results | Queries (symbol names, file paths, project ID, branch) to the Constellation API at `https://api.constellationdev.io`, or the self-hosted URL you configure via `CONSTELLATION_API_URL` or `constellation.json`, authenticated with `CONSTELLATION_ACCESS_KEY`. **Source code is never sent to the Constellation API.** Code snippets are returned only to Claude in the local session |
| **MCP server usage metrics** | Runs after each `code_intel` call. On by default; set `CONSTELLATION_USAGE_METRICS=false` to turn it off | A usage event (project ID, branch, which API methods ran, estimated token counts, durations) to the same Constellation API at `/intel/v1/usage`, or to `USAGE_ENDPOINT_URL` if you set it, authenticated with `CONSTELLATION_ACCESS_KEY`. Contains no source code, snippets, or symbol contents |
| **Hooks module** (`hooks/register.ts`) | Runs in-process in Claude Code. Calls: `$.env.get` (reads `CONSTELLATION_ACCESS_KEY`), `$.session.cwd`, `$.session.surfaces`, `$.fs.exists` (looks for `constellation.json` in parent directories), `$.mcp.connect` and `$.mcp.call` (queries the `code_intel` server above) | Nothing beyond what `code_intel` already sends |
| **Hooks** | Check whether `CONSTELLATION_ACCESS_KEY` is set and starts with `ak:`; the Bash hook inspects the command Claude is about to run | Nothing. They only add a `code_intel` reminder to Claude's context |
| **Commands & skills** | Call the `code_intel` MCP tool | Nothing beyond the MCP server above |

`CONSTELLATION_ACCESS_KEY` is the same credential used by the `constellation` CLI and other Constellation integrations. Set it with `constellation auth`, which signs you in through the browser.

## Installation

### Prerequisites

1. **Constellation Account** (see [Constellation](https://app.constellationdev.io))
2. **Project indexed** in Constellation
3. **Access key** configured

### Quick Start

```bash
# Add the marketplace to Claude
claude plugin marketplace add ShiftinBits/constellation-claude

# Install the Constellation Claude plugin
claude plugin install constellation@constellation-plugins --scope project
```

## Usage Examples

### Check Your Setup

```
> /constellation:status

Status: Connected
Project: my-awesome-app
Files Indexed: 1,247
Symbols: 8,932
Languages: TypeScript, JavaScript
```

### Analyze Before Refactoring

```
> /constellation:impact validateUser src/auth/validator.ts

Symbol: validateUser (function)
Risk Level: MEDIUM
Files Affected: 12
Symbols Affected: 34
Impacted Test Files: 3

Recommendations:
- Update unit tests in auth.spec.ts
- Check integration with UserController
```

### Find Dead Code

```
> /constellation:unused --kind function

Found 7 orphaned functions:
├── src/utils/legacy.ts
│   ├── formatLegacyDate (line 23)
│   └── parseLegacyConfig (line 45)
├── src/helpers/deprecated.ts
│   └── oldValidation (line 12)
...
```

### Understand Dependencies

```
> /constellation:deps src/services/payment.service.ts

Dependencies (12):
├── Internal (8)
│   ├── src/models/payment.model.ts
│   ├── src/utils/currency.ts
│   └── ...
└── External (4)
    ├── stripe
    ├── lodash
    └── ...

No circular dependencies detected.
```

## Troubleshooting

### Common Issues

| Issue | Solution |
|-------|----------|
| `AUTH_ERROR` | Check `CONSTELLATION_ACCESS_KEY` is set correctly, use `constellation auth` CLI command to set |
| `PROJECT_NOT_INDEXED` | Run `constellation index --full` in your project |
| Commands not appearing | Restart Claude Code or check plugin path |

## Documentation

- [Constellation Documentation](https://docs.constellationdev.io) — Full platform documentation
- [MCP Server](https://github.com/shiftinbits/constellation-mcp) — Underlying MCP server
- [Claude Code Plugins](https://docs.anthropic.com/claude-code/plugins) — Plugin development guide

## License

GNU Affero General Public License v3.0 (AGPL-3.0)

Copyright © 2026 ShiftinBits Inc.

See [LICENSE](LICENSE) file for details.
