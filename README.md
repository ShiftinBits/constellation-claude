# <img src="https://constellationdev.io/clawd-icon.svg" height="30"> Constellation Plugin for Claude Code

[![MCP Server](https://img.shields.io/badge/mcp-@constellationdev/mcp-black.svg?logo=modelcontextprotocol)](https://github.com/ShiftinBits/constellation-mcp) [![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-3DA639?logo=opensourceinitiative&logoColor=white)](LICENSE)

While Constellation's MCP server provides raw code intelligence capabilities, this plugin enhances your Claude Code experience with:

| Feature | Benefit |
|---------|---------|
| **Slash Commands** | Quick access to common workflows |
| **Contextual Skills** | Claude automatically loads relevant knowledge — including proactive impact analysis before risky changes |
| **Safety Hooks** | Nudges Claude toward `code_intel` over text search at session start, in subagents, in the search tools' descriptions, and before symbol-like searches inside indexed projects, and adds a one-line `code_intel` hint to the result of a symbol search |

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
| **Reminder budget** | `turn.start`, `tool.call` (`code_intel`), `classic.SessionStart` (clear, resume, fork) | Caps the search reminders at `nudgeLimit` per session (default 3), counted separately for each subagent, and skips a reminder when `code_intel` was already called earlier in the same turn. See [Reminder limit](#reminder-limit) |
| **Search result hint** | `tool.call` (`Grep\|Bash`) | After a symbol search with Grep, or with `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` in the shell, looks the symbol up with `code_intel` and adds one line to the search result, for example `✦ code_intel: AuthService is a class at src/auth/auth.service.ts:12 (4 dependents). Use code_intel for references, callers, and impact.` See [Search result hint](#search-result-hint) |

All hooks are gated on `CONSTELLATION_ACCESS_KEY` being set and starting with `ak:` (no key means a silent no-op, so the plugin doesn't nag in environments where Constellation isn't configured). The tool description guidance, the search nudges and the search result hint also require a `constellation.json` in the searched directory (the call's `path` for Grep and Glob when set, else the working directory) or a parent, so they stay out of projects that are not indexed. Subagents such as Explore see the same rewritten descriptions. The reminders are added to what the call already returns, so a permission decision made by another hook is kept.

#### Reminder limit

The search reminders are limited so they stay useful instead of repeating on every search:

- **Per session:** Claude gets at most `nudgeLimit` reminders (default `3`). Only searches that would have drawn a reminder count against it. Each subagent has its own limit, because its context starts empty.
- **Same turn:** when `code_intel` was already called earlier in the same turn, a symbol search in that turn gets no reminder and uses none of the limit.
- **Reset:** the count starts over after `/clear` and when a session is resumed or forked.
- **Not limited:** the session and subagent awareness text, and the tool description guidance, are not counted.

Set `nudgeLimit` with `/config` (it appears under the Constellation plugin) or run `claude plugin configure constellation`. A value of `0` turns the search reminders off while keeping the awareness text and the description guidance.

#### Search result hint

When Claude searches for a symbol with Grep, or with `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` in the shell, the search runs first and its result is kept as it is. The plugin then looks the symbol up with `code_intel` (an exact-name match and the files that import it) and adds one line after the result, so Claude learns the graph has the answer without being told off for searching. It applies to subagent searches too.

- **Once per symbol:** each symbol gets the hint once while the plugin is loaded. A lookup that fails, runs late, or finds no exact match does not count, so a later search can still get it.
- **Never in the way:** the lookup has 2.5 seconds, which allows for the MCP server starting up. Past that, or on any error, the search result comes back unchanged.
- **Skipped** when `code_intel` was already called earlier in the same turn, for patterns that are not symbol-like (the same rules as the reminders), and outside indexed projects.
- **Not limited by `nudgeLimit`:** the hint has its own once-per-symbol rule and never uses the reminder count.

Turn it off by setting `augmentGrep` to `false` with `/config` or `claude plugin configure constellation`.

### Mods

The hooks above come from a hooks module (`hooks/register.ts`) that Claude Code loads and runs in-process, in the same session, instead of starting a separate `node` process per event. The module makes no network requests of its own and spawns no processes; the search result hint queries through the plugin's own MCP server. It uses only the Claude Code calls listed under [Data Handling](#data-handling).

- **Version floor:** Claude Code 2.1.287. Older builds are expected to ignore the module, so the hooks do nothing there.
- **Turn it off:** disable the plugin from `/plugin`, start Claude Code with `--safe-mode`, or set `disableAllHooks` in your settings.

## Data Handling

What the plugin runs, reads, and sends:

| Component | Runs / reads | Sends |
|-----------|--------------|-------|
| **MCP server** | Started with `npx -y @constellationdev/mcp@<pinned version>`, which downloads the package from the npm registry. Reads `constellation.json` and the current git branch from your project, and reads lines from local source files to attach code snippets to query results | Queries (symbol names, file paths, project ID, branch) to the Constellation API at `https://api.constellationdev.io`, or the self-hosted URL you configure via `CONSTELLATION_API_URL` or `constellation.json`, authenticated with `CONSTELLATION_ACCESS_KEY`. **Source code is never sent to the Constellation API.** Code snippets are returned only to Claude in the local session |
| **MCP server usage metrics** | Runs after each `code_intel` call. On by default; set `CONSTELLATION_USAGE_METRICS=false` to turn it off | A usage event (project ID, branch, which API methods ran, estimated token counts, durations) to the same Constellation API at `/intel/v1/usage`, or to `USAGE_ENDPOINT_URL` if you set it, authenticated with `CONSTELLATION_ACCESS_KEY`. Contains no source code, snippets, or symbol contents |
| **Hooks** (`hooks/register.ts`) | Run in-process in Claude Code. Calls: `$.clock.sleep` (the search result hint's 2.5 second deadline), `$.env.get` (reads `CONSTELLATION_ACCESS_KEY` and checks it starts with `ak:`), `$.fs.exists` (checks for `constellation.json` in the working directory and its parents), `$.mcp.call` and `$.mcp.connect` (run the search result hint's `code_intel` lookup through the plugin's MCP server), `$.session.cwd` (reads the working directory), `$.ui.invalidate` (asks Claude Code to rebuild the search tool descriptions when the working directory moves in or out of an indexed project). For a Bash call they inspect the command Claude is about to run. A reminder count and the symbols already hinted are kept in memory only, never written to disk | Nothing directly. They add `code_intel` reminders, guidance and search result hints to Claude's context; the hint's lookup is sent by the MCP server, as below |
| **Search result hint** (`hooks/augment.ts`, option `augmentGrep`, on by default) | Covers Grep and shell `grep`, `egrep`, `rg`, `ag`, `ack` and `git grep` searches. Reads the search pattern, and the identifier in it, from the call; never reads the search output | Only the identifier from the search pattern (for example `AuthService`), as a `code_intel` `searchSymbols` query through the MCP server above, the same as any `searchSymbols` query, then a `getDependents` query for the file path that search returned. Nothing from the search output is sent |
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
