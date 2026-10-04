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
| **Bash Search Nudge** | `classic.PreToolUse` (`Bash`) | Parses the leading command, up to the first unquoted `\|`, `;`, `&&` or `\|\|` (or the command after a leading `cd <dir> &&`). When it is `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` (also after `git -C <dir>` or variable assignments such as `LC_ALL=C`) and the pattern looks like a symbol, adds the same reminder when the searched directory is inside an indexed project. Flags and their values (`-t ts`, `-A 3`, `-g '*.ts'`) are skipped, and language keywords such as `import` are not symbols. A grep after a pipe, `awk`, and `findstr` no longer trigger a reminder |
| **Tool description guidance** | `tool.describe` (`Grep\|Glob\|Bash`) | Appends a short rule to the description of the search tools: use `code_intel` for symbol definitions, references, dependents, call graphs and impact, and keep text search for literal text. Applied once per session; if the session starts outside an indexed project, it is added once the working directory moves into one, and then kept, so moving around never rewrites the prompt cache. Native macOS and Linux builds have no Grep or Glob tool, so there it is the Bash description that carries the rule |
| **Reminder budget** | `turn.start`, `tool.call` (`code_intel`), `classic.SessionStart` (clear, resume, fork) | Caps the search reminders at `nudgeLimit` per session (default 3), counted separately for each subagent, and skips a reminder when `code_intel` was already called earlier in the same turn. See [Reminder limit](#reminder-limit) |
| **Search result hint** | `tool.call` (`Grep\|Bash`) | After a symbol search with Grep, or with `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` in the shell, looks the symbol up with `code_intel` and adds one line to the search result, for example `>_CONSTELLATION:// AuthService (class) is defined at src/auth/auth.service.ts:12, with 4 usages. Use code_intel for references, callers, and impact.` See [Search result hint](#search-result-hint) |

All hooks are gated on `CONSTELLATION_ACCESS_KEY` being set and starting with `ak:` (no key means a silent no-op, so the plugin doesn't nag in environments where Constellation isn't configured). The tool description guidance, the search nudges and the search result hint also require a `constellation.json` in the searched directory (the call's `path` for Grep and Glob when set, else the working directory) or a parent, so they stay out of projects that are not indexed. Subagents such as Explore see the same rewritten descriptions. The reminders are added to what the call already returns, so a permission decision made by another hook is kept.

#### Reminder limit

The search reminders are limited so they stay useful instead of repeating on every search:

- **Per session:** Claude gets at most `nudgeLimit` reminders (default `3`). Only searches that would have drawn a reminder count against it. Each subagent has its own limit, because its context starts empty.
- **Same turn:** when `code_intel` was already called earlier in the same turn, a symbol search in that turn gets no reminder and uses none of the limit.
- **Reset:** the count starts over after `/clear` and when a session is resumed or forked.
- **Not limited:** the session and subagent awareness text, and the tool description guidance, are not counted.

Set `nudgeLimit` with `/config` (it appears under the Constellation plugin) or run `claude plugin configure constellation`. A value of `0` turns the search reminders off while keeping the awareness text and the description guidance.

#### Search result hint

When Claude searches for a symbol with Grep, or with `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` in the shell, the search runs first and its result is kept as it is. The plugin then looks the symbol up with `code_intel` (the most used exact-name match, exported symbols first, with its usage count from the graph) and adds one line after the result, so Claude learns the graph has the answer without being told off for searching. It applies to subagent searches too.

- **Once per symbol:** each symbol gets the hint once per project and per agent (the main conversation and each subagent), and again after `/clear`, `/resume` or `/branch`. Two searches running at once show it once.
- **Never in the way:** the lookup starts with the search and has 2.5 seconds after the search finishes, which allows for the MCP server starting up. Past that, or on any error, the search result comes back unchanged. A symbol with no exact match is remembered, and a failed lookup (server down, sign-in needed) is not retried for a minute, so neither slows later searches.
- **Skipped** when `code_intel` was already called earlier in the same turn, for patterns that are not symbol-like (the same rules as the reminders), and outside indexed projects.
- **Not limited by `nudgeLimit`:** the hint has its own once-per-symbol rule and never uses the reminder count.

Turn it off by setting `augmentGrep` to `false` with `/config` or `claude plugin configure constellation`.

### Mods

The hooks above come from a hooks module (`hooks/register.ts`) that Claude Code loads and runs in-process, in the same session, instead of starting a separate `node` process per event. The module makes no network requests of its own. It runs git (`git rev-parse`, `git symbolic-ref` and `git diff --name-only`) only through Claude Code's process call, when Claude runs `gh pr create`; the search result hint and the `/constellation` command query through the plugin's own MCP server. It uses only the Claude Code calls listed under [Data Handling](#data-handling).

- **`/constellation` command:** a pane with Status, Diagnose, Deps and Unused tabs (keys `1` to `4`, `r` to refresh, `Esc` to close), run as `/constellation [status|diagnose|deps <file>|unused]`. It starts no model turn and works while Claude is mid-turn. Where the session cannot draw a pane (for example VS Code), it answers with a few lines of text instead. The Markdown `/constellation:*` commands remain.
- **Layout:** the pane opens with the Constellation banner in the CLI's gradient, then the project name with the index's commit and age, the tabs with a one-line description, labeled rows, and a line naming the keys. The header follows the pane's width: the full banner from 72 columns, a smaller boxed header from 23, and one line below that or in the Desktop app.
- **Project picker:** run from a folder that holds several Constellation projects (such as a monorepo root), the pane lists them, one per row with when each was indexed, its languages and its file count. Press a row's number (or Enter on the first) to open it. The pick is remembered for that folder across sessions; `p` (switch project) in the pane's header forgets it and shows the list again.
- **Colors:** the `colors` option, set with `/config` or `claude plugin configure constellation`. `brand` (the default) uses the Constellation palette and switches to Claude Code's own theme colors on light, ANSI and color-blind themes; `theme` always uses Claude Code's theme colors; `none` draws no color. Every status also carries a word and a symbol, so no setting loses information.
- **Impact gate:** the `impactGate` option, set with `/config` or `claude plugin configure constellation`, is `off` by default. `dialog` asks you before an edit Claude Code would run without asking, to a file whose impact is at or above `impactThreshold`, offering Proceed, Proceed and don't ask again for this file, or Cancel; an edit already headed to the permission prompt gets a one-line impact summary beside it instead. In auto mode, where such an edit goes to the auto-mode classifier rather than to you, both `dialog` and `native` ask you first, and the classifier still decides after you choose Proceed. `native` sends that edit to Claude Code's own permission prompt, with the summary as a toast. `require-analysis` refuses Claude's first edit to such a file once, with the impact report as the reason, unless Claude already ran a `code_intel` impact query (`impactAnalysis`, `traceSymbolUsage` or `getDependents`) naming the file or a symbol its dependents import; the retry goes through. It is the mode for CI and headless runs, where no one can answer a dialog or a prompt. `impactThreshold` is `high` (the default) or `critical`. Dependents come from the last indexed commit, so a branch with unindexed changes can show fewer or more than the working tree has. Counts can also fall short where imports go through `tsconfig` path aliases or `export *` barrels. Any failure to read the impact, or a lookup that takes more than 3 seconds, lets the edit through; in `require-analysis` that edit was the file's one check, so later edits to it go through as well.
- **Turn impact summary:** the `turnSummary` option, on by default. After a turn that changed files, one line appears under Claude's answer, for example `>_CONSTELLATION:// 3 files changed (1 new) · 12 downstream dependents (4 test files) · as of fba36d5`. It counts edits made by subagents too. A file created this turn counts as new and is not queried. Only files under the first edited file's project root are queried. Files deleted with a shell `rm` are not tracked. Dependents come from the indexed commit (the 7-character commit is shown) and undercount imports through `tsconfig` path aliases and `export *` barrels.
- **PR impact section:** the `prImpact` option, `inform` (the default), `require` or `off`. When Claude runs `gh pr create` (recognized anywhere in a `&&` or `;` chain), the plugin lists the branch's changed files, their downstream dependents, the affected test files and the exported symbols in the changed files. `inform` lets the command run and logs the section; `require` refuses the command once per branch per session, with the section as the reason, until the PR body has an `## Impact` heading. It fails open: a git or `code_intel` error lets the command run. Dependents come from the indexed commit (shown as its 7-character commit) and undercount imports through `tsconfig` path aliases and `export *` barrels.
- **Version floor:** Claude Code 2.1.287. `hooks/hooks.json` keeps an empty `"hooks"` block beside `"modules"`, so older builds should still read it as a valid hooks file and simply run no hooks. This has not been tested on an older build.
- **Turn it off:** disable the plugin from `/plugin`, start Claude Code with `--safe-mode`, or set `disableAllHooks` in your settings.

## Data Handling

What the plugin runs, reads, and sends:

| Component | Runs / reads | Sends |
|-----------|--------------|-------|
| **MCP server** | Started with `npx -y @constellationdev/mcp@<pinned version>`, which downloads the package from the npm registry. Reads `constellation.json` and the current git branch from your project, and reads lines from local source files to attach code snippets to query results | Queries (symbol names, file paths, project ID, branch) to the Constellation API at `https://api.constellationdev.io`, or the self-hosted URL you configure via `CONSTELLATION_API_URL` or `constellation.json`, authenticated with `CONSTELLATION_ACCESS_KEY`. **Source code is never sent to the Constellation API.** Code snippets are returned only to Claude in the local session |
| **MCP server usage metrics** | Runs after each `code_intel` call. On by default; set `CONSTELLATION_USAGE_METRICS=false` to turn it off | A usage event (project ID, branch, which API methods ran, estimated token counts, durations) to the same Constellation API at `/intel/v1/usage`, or to `USAGE_ENDPOINT_URL` if you set it, authenticated with `CONSTELLATION_ACCESS_KEY`. Contains no source code, snippets, or symbol contents |
| **Hooks** (`hooks/register.ts`) | Run in-process in Claude Code. Calls: `$.clock.after` (retries a failed search result hint or impact lookup after a minute, and re-reads a file's impact after five minutes), `$.clock.sleep` (the search result hint's 2.5 second deadline, the impact gate's 3 second one, the turn summary's 2 second one and the PR impact section's 8 second one), `$.command.register` (adds the `/constellation` command), `$.config.list` (reads Claude Code's theme to choose the pane's colors), `$.env.get` (reads `CONSTELLATION_ACCESS_KEY` and checks it starts with `ak:`), `$.fs.exists` (checks for `constellation.json` in the searched directory and its parents, and whether a file about to be edited already exists), `$.fs.read` (reads the `--body-file` of `gh pr create` to check for an Impact heading), `$.mcp.call` and `$.mcp.connect` (run the search result hint's, the `/constellation` command's, the impact gate's, the turn summary's and the PR impact section's `code_intel` queries through the plugin's MCP server), `$.process.run` (runs `git rev-parse`, `git symbolic-ref` and `git diff --name-only` in the project root when Claude runs `gh pr create`), `$.session.cwd` (reads the working directory), `$.session.surfaces` (checks whether the session can draw a pane, or has someone to answer the impact dialog), `$.store.delete`, `$.store.get` and `$.store.set` (remember, per folder, the project picked in the `/constellation` pane when that folder holds several projects), `$.ui.ask` (asks before an auto-approved edit to a high-impact file, in dialog mode), `$.ui.close` (closes the `/constellation` pane), `$.ui.invalidate` (asks Claude Code to rebuild the search tool descriptions once, when the working directory first moves into an indexed project, and to redraw the `/constellation` pane when its state or a query result changes), `$.ui.log` (notes an edit that was allowed because the impact dialog could not open), `$.ui.open` (opens the `/constellation` pane), `$.ui.resolve` (reads the element table the pane is drawn with), `$.ui.toast` (shows the impact summary next to a permission prompt). For a Bash call they inspect the command Claude is about to run. The `/constellation` command sends `ping`, `getCapabilities`, `getDependencies`, `getDependents` and `findOrphanedCode` queries through the MCP server (file paths only). A reminder count, the symbols already hinted, the pane's state, the files you chose not to be asked about again, the files already assessed for each agent and, in `require-analysis` mode only, the paths and names each agent's `code_intel` impact queries asked about are kept in memory only. The one thing written to disk is the picked project: the folder's path and the project's path, in this plugin's own store under `~/.claude/plugins/store/`, removed by switch project | Nothing directly. They add `code_intel` reminders, guidance and search result hints to Claude's context; the hint's lookup is sent by the MCP server, as below |
| **Search result hint** (`hooks/augment.ts`, option `augmentGrep`, on by default) | Covers Grep and shell `grep`, `egrep`, `rg`, `ag`, `ack` and `git grep` searches. Reads the search pattern, and the identifier in it, from the call; never reads the search output | Only the identifier from the search pattern (for example `AuthService`), as `code_intel` `searchSymbols` queries through the MCP server above, the same as any `searchSymbols` query. Nothing from the search output is sent |
| **Impact gate** (`hooks/impact.ts`, `hooks/risk.ts`, option `impactGate`, off by default) | Reads the path of a file Claude is about to edit (`file_path`, or `notebook_path` for a notebook) and turns it into a path relative to the project root. In `dialog` and `native` modes it also reads the permission mode from each submitted prompt (`classic.UserPromptSubmit`), never the prompt's text | Only that project-relative file path, to `code_intel` `getDependents` (with the symbols each dependent imports) through the MCP server. Nothing from the file's contents |
| **Turn impact summary** (`hooks/turnsummary.ts`, `hooks/blast.ts`, option `turnSummary`, on by default) | Reads the paths of files Claude edits (`file_path`, or `notebook_path` for a notebook) and turns them into paths relative to the project root | Only project-relative paths, to `code_intel` `getDependents` through the MCP server. Nothing from the files' contents |
| **PR impact section** (`hooks/primpact.ts`, `hooks/blast.ts`, option `prImpact`) | Reads the `gh pr create` command, the PR body or body file, and the branch's changed file names from git | Only project-relative paths, to `code_intel` `getDependents` and `searchSymbols` (exported symbols). Never the body text or file contents |
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
