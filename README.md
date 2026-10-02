# <img src="https://constellationdev.io/clawd-icon.svg" height="30"> Constellation Plugin for Claude Code

[![MCP Server](https://img.shields.io/badge/mcp-@constellationdev/mcp-black.svg?logo=modelcontextprotocol)](https://github.com/ShiftinBits/constellation-mcp) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-3DA639?logo=opensourceinitiative&logoColor=white)](LICENSE)

While Constellation's MCP server provides raw code intelligence capabilities, this plugin enhances your Claude Code experience with:

| Feature | Benefit |
|---------|---------|
| **Slash Commands** | Quick access to common workflows |
| **Contextual Skills** | Claude automatically loads relevant knowledge — including proactive impact analysis before risky changes |
| **Safety Hooks** | Nudges Claude toward `code_intel` over text search at session start, in subagents, in the search tools' descriptions, and before symbol-like searches inside indexed projects |

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

Event hooks enable intelligent, transparent assistance. They run in-process inside Claude Code, declared by the plugin's hooks module (`hooks/register.ts`):

| Hook | Event (matcher) | Behavior |
|------|-----------------|----------|
| **Session Awareness** | `classic.SessionStart` | Injects `code_intel` MCP tool awareness at session start, including after clear, resume, and compact |
| **Subagent Awareness** | `classic.SubagentStart` | Injects `code_intel` awareness into spawned subagents (built-ins like Explore/Plan don't inherit project AGENTS.md) |
| **Search Tool Nudge** | `classic.PreToolUse` (`Grep\|Glob`) | Reminds Claude to prefer `code_intel` when a Grep pattern looks like a symbol (`AuthService`, `class UserService`, `getUser\(`), or a Glob has a PascalCase or camelCase file stem (`**/UserService.ts`), and the search is inside an indexed project. Quoted phrases, error text, `TODO`-style markers, regex with character classes or alternation, and extension globs such as `**/*.ts` get no reminder |
| **Bash Search Nudge** | `classic.PreToolUse` (`Bash`) | Parses only the leading command, up to the first unquoted `\|`, `;`, `&&` or `\|\|`. When it is `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` and the pattern looks like a symbol, adds the same reminder inside an indexed project. A grep after a pipe, `awk`, and `findstr` no longer trigger a reminder |
| **Tool description guidance** | `tool.describe` (`Grep\|Glob\|Bash`) | Appends a short rule to the description of the search tools: use `code_intel` for symbol definitions, references, dependents, call graphs and impact, and keep text search for literal text. Applied once per session, and again only when the working directory moves into or out of an indexed project. Native macOS and Linux builds have no Grep or Glob tool, so there it is the Bash description that carries the rule |

All hooks are gated on `CONSTELLATION_ACCESS_KEY` being set and starting with `ak:` (no key means a silent no-op, so the plugin doesn't nag in environments where Constellation isn't configured). The tool description guidance and the search nudges also require a `constellation.json` in the searched directory (the call's `path` for Grep and Glob when set, else the working directory) or a parent, so they stay out of projects that are not indexed. Subagents such as Explore see the same rewritten descriptions. The reminders are added to what the call already returns, so a permission decision made by another hook is kept.

### Mods

The hooks above come from a hooks module (`hooks/register.ts`) that Claude Code loads and runs in-process, in the same session, instead of starting a separate `node` process per event. The module makes no network requests and spawns no processes. It uses only the Claude Code calls listed under [Data Handling](#data-handling).

- **Version floor:** Claude Code 2.1.287. Older builds are expected to ignore the module, so the hooks do nothing there.
- **Turn it off:** disable the plugin from `/plugin`, start Claude Code with `--safe-mode`, or set `disableAllHooks` in your settings.

## Data Handling

What the plugin runs, reads, and sends:

| Component | Runs / reads | Sends |
|-----------|--------------|-------|
| **MCP server** | Started with `npx -y @constellationdev/mcp@<pinned version>`, which downloads the package from the npm registry. Reads `constellation.json` and the current git branch from your project, and reads lines from local source files to attach code snippets to query results | Queries (symbol names, file paths, project ID, branch) to the Constellation API at `https://api.constellationdev.io`, or the self-hosted URL you configure via `CONSTELLATION_API_URL` or `constellation.json`, authenticated with `CONSTELLATION_ACCESS_KEY`. **Source code is never sent to the Constellation API.** Code snippets are returned only to Claude in the local session |
| **MCP server usage metrics** | Runs after each `code_intel` call. On by default; set `CONSTELLATION_USAGE_METRICS=false` to turn it off | A usage event (project ID, branch, which API methods ran, estimated token counts, durations) to the same Constellation API at `/intel/v1/usage`, or to `USAGE_ENDPOINT_URL` if you set it, authenticated with `CONSTELLATION_ACCESS_KEY`. Contains no source code, snippets, or symbol contents |
| **Hooks** (`hooks/register.ts`) | Run in-process in Claude Code. Calls: `$.env.get` (reads `CONSTELLATION_ACCESS_KEY` and checks it starts with `ak:`), `$.session.cwd` (reads the working directory), `$.fs.exists` (checks for `constellation.json` in the working directory and its parents), `$.ui.invalidate` (asks Claude Code to rebuild the search tool descriptions when the working directory moves in or out of an indexed project). For a Bash call they inspect the command Claude is about to run | Nothing. They only add `code_intel` reminders and guidance to Claude's context |
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
