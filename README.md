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
| **Search Tool Nudge** | `tool.call` (`Grep\|Glob`) | Reminds Claude to prefer `code_intel` when a Grep pattern looks like a symbol (`AuthService`, `class UserService`, `getUser\(`), or a Glob has a PascalCase or camelCase file stem (`**/UserService.ts`), and the search is inside an indexed project. Quoted phrases, error text, `TODO`-style markers, regex with character classes or alternation, and extension globs such as `**/*.ts` get no reminder |
| **Bash Search Nudge** | `tool.call` (`Bash`) | Parses the leading command, up to the first unquoted `\|`, `;`, `&&` or `\|\|` (or the command after a leading `cd <dir> &&`). When it is `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` (also after `git -C <dir>` or variable assignments such as `LC_ALL=C`) and the pattern looks like a symbol, adds the same reminder when the searched directory is inside an indexed project. Flags and their values (`-t ts`, `-A 3`, `-g '*.ts'`) are skipped, and language keywords such as `import` are not symbols. A grep after a pipe, `awk`, and `findstr` no longer trigger a reminder |
| **Tool description guidance** | `tool.describe` (`Grep\|Glob\|Bash`) | Appends a short rule to the description of the search tools: use `code_intel` for symbol definitions, references, dependents, call graphs and impact, and keep text search for literal text. Applied once per session; if the session starts outside an indexed project, it is added once the working directory moves into one, and then kept, so moving around never rewrites the prompt cache. Native macOS and Linux builds have no Grep or Glob tool, so there it is the Bash description that carries the rule |
| **Reminder budget** | `turn.start`, `tool.call` (`code_intel`), `classic.SessionStart` (clear, resume, fork) | Caps the search reminders at `nudgeLimit` per session (default 3), counted separately for each subagent, and skips a reminder when `code_intel` was already called earlier in the same turn. See [Reminder limit](#reminder-limit) |
| **Adoption counter** | `tool.call` (`code_intel`), `tool.call` (`Grep\|Glob\|Bash`), `ui.render` (`Spinner`, only with `showAdoption`) | Counts Claude's `code_intel` calls and, with a key and inside an indexed project, its text searches (symbol-like or literal), for the session and per day, on this machine only. Shown on the Stats tab of `/constellation` and, with `showAdoption` on, beside the spinner. See [Adoption counter](#adoption-counter) |
| **Search result hint** | `tool.call` (`Grep\|Bash`) | After a symbol search with Grep, or with `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` in the shell, looks the symbol up with `code_intel` and adds one line to the search result, for example `>_CONSTELLATION:// AuthService (class) is defined at src/auth/auth.service.ts:12, with 4 usages. Use code_intel for references, callers, and impact.` See [Search result hint](#search-result-hint) |

All hooks are gated on `CONSTELLATION_ACCESS_KEY` being set and starting with `ak:` (no key means a silent no-op, so the plugin doesn't nag in environments where Constellation isn't configured), with one exception: the adoption counter counts a `code_intel` call with or without a key. The counter only counts and adds nothing to Claude's context. The tool description guidance, the search nudges, the search result hint and the counting of text searches also require a `constellation.json` in the searched directory (the call's `path` for Grep and Glob when set, else the working directory) or a parent, so they stay out of projects that are not indexed. Subagents such as Explore see the same rewritten descriptions. The reminders are added to what the call already returns, so a permission decision made by another hook is kept.

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

#### Adoption counter

The plugin counts how often Claude uses `code_intel` beside how often it searches text, so you can see whether the reminders work. The counts stay on your machine: they are never sent to Constellation or anywhere else.

- **What counts:** each `code_intel` call Claude or a subagent makes (with the time the call reported), and each search Claude or a subagent runs with Grep, Glob, or `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep` in the shell, as symbol-like or literal by the same rules as the reminders. A search counts only where `code_intel` could have answered it: with an access key set, and inside an indexed project (a `constellation.json` in the searched directory or a parent).
- **What does not:** the plugin's own `code_intel` lookups (the search result hint, the impact features, the `/constellation` pane), a search another plugin runs, a search with no access key or outside an indexed project, a call or search that was refused, and shell commands that are not searches.
- **Structural lookups:** the percentage is `code_intel` calls out of `code_intel` calls plus symbol-like searches. Literal searches are shown but left out of it, because `code_intel` could not have answered them.
- **Where to see it:** the Stats tab of `/constellation` (or `/constellation stats`) shows this session, today and the last 30 days. Set `showAdoption` to `true` with `/config` or `claude plugin configure constellation` to also show the session's counts beside the spinner. It is off by default.
- **What is kept:** numbers only, one entry per session per day, in the plugin's own store. They are saved in the background, so a tool's result never waits on the store. Entries older than 30 days are deleted on the first count of a session and when the Stats tab or `/constellation stats` reads them. The session's counts start over after `/clear` and when a session is resumed or forked; the daily totals stay.

### Mods

The hooks above come from a hooks module (`hooks/register.ts`) that Claude Code loads and runs in-process, in the same session, instead of starting a separate `node` process per event. The module makes no network requests of its own. It runs git (`git rev-parse`, `git symbolic-ref` and `git diff --name-only`) only through Claude Code's process call, when Claude runs `gh pr create`; the search result hint and the `/constellation` command query through the plugin's own MCP server. It uses only the Claude Code calls listed under [Data Handling](#data-handling).

- **`/constellation` command:** a pane with Status, Diagnose, Deps, Unused, Explore and Stats tabs (keys `1` to `6`, `r` to refresh, `Esc` to close), run as `/constellation [status|diagnose|deps <file>|unused [kind]|explore [query]|stats]`. The Stats tab shows the [adoption counter](#adoption-counter) for this session, today and the last 30 days, all three read at the same moment (Refresh reads them again); it sends no query and opens without a key or an indexed project. It starts no model turn and works while Claude is mid-turn. Where the session cannot draw a pane (for example VS Code), it answers with a few lines of text instead. The Markdown `/constellation:*` commands remain.
- **Layout:** the pane opens with the Constellation banner in the CLI's gradient, then the project name with the index's commit and age, the tabs with a one-line description, labeled rows, and a line naming the keys. The header follows the pane's width: the full banner from 72 columns, a smaller boxed header from 23, and one line below that or in the Desktop app.
- **Project picker:** run from a folder that holds several Constellation projects (such as a monorepo root), the pane lists them, one per row with when each was indexed, its languages and its file count. Press a row's number (or Enter on the first) to open it. The pick is remembered for that folder across sessions; `p` (switch project) in the pane's header forgets it and shows the list again.
- **Colors:** the `colors` option, set with `/config` or `claude plugin configure constellation`. `brand` (the default) uses the Constellation palette and switches to Claude Code's own theme colors on light, ANSI and color-blind themes; `theme` always uses Claude Code's theme colors; `none` draws no color. Every status also carries a word and a symbol, so no setting loses information.
- **Impact gate:** the `impactGate` option, set with `/config` or `claude plugin configure constellation`, is `off` by default. `dialog` asks you before an edit Claude Code would run without asking, to a file whose impact is at or above `impactThreshold`, offering Proceed, Proceed and don't ask again for this file, or Cancel; an edit already headed to the permission prompt gets a one-line impact summary beside it instead. In auto mode, where such an edit goes to the auto-mode classifier rather than to you, both `dialog` and `native` ask you first, and the classifier still decides after you choose Proceed. `native` sends that edit to Claude Code's own permission prompt, with the summary as a toast. `require-analysis` refuses Claude's first edit to such a file once, with the impact report as the reason, unless Claude already ran a `code_intel` impact query (`impactAnalysis`, `traceSymbolUsage` or `getDependents`) naming the file or a symbol its dependents import; the retry goes through. It is the mode for CI and headless runs, where no one can answer a dialog or a prompt. `impactThreshold` is `high` (the default) or `critical`. Dependents come from the last indexed commit, so a branch with unindexed changes can show fewer or more than the working tree has. Counts can also fall short where imports go through `tsconfig` path aliases or `export *` barrels. Any failure to read the impact, or a lookup that takes more than 3 seconds, lets the edit through; in `require-analysis` that edit was the file's one check, so later edits to it go through as well.
- **Tool rows:** `code_intel` calls and results in the transcript get compact rows, for example `✦ code_intel · impactAnalysis · constellation-core` and `✗ HIGH · 23 dependents · 140 ms · as of abc1234`. The result row summarizes what came back; an error shows its headline and the next step, for example `✗ AUTH_ERROR · Your access key wasn't accepted · constellation auth`. An interrupted call, a result too large to read and a failure without an error code keep Claude Code's own row. Colors follow the `colors` option. With `--verbose`, Claude Code's own drawing also shows under the row.
- **Turn impact summary:** the `turnSummary` option, on by default. After a turn that changed files, one line appears under Claude's answer, for example `>_CONSTELLATION:// 3 files changed (1 new) · 12 downstream dependents (4 test files) · as of fba36d5`. It counts edits made by subagents too. A file created this turn counts as new and is not queried. Only files in one project are counted and queried: the project of the first edited file inside one, so plan or scratch files and files in other projects are left out. A count of `100+` means a file has at least that many dependents. Files deleted with a shell `rm` are not tracked. Dependents come from the indexed commit (the 7-character commit is shown) and undercount imports through `tsconfig` path aliases and `export *` barrels.
- **PR impact section:** the `prImpact` option, `inform` (the default), `require` or `off`. When Claude runs `gh pr create` or `gh pr new` (recognized anywhere in a `&&` or `;` chain or on a later line), the plugin lists the branch's changed files, their downstream dependents (those importing the most changed files first), the affected test files and the changed files' exported symbols that other files import. A PR for another branch (`--head`) or repository (`--repo` or `GH_REPO`), or after a `cd` the shell expands (`~`, `$VAR`, `-`), is left alone. Without `--base`, the base is the remote's default branch (`origin/HEAD`, else `origin/main` or `origin/master` when it exists); in a fork that is the fork's default branch, so pass `--base` there. A body file the same command writes is checked through the command text; a body file that cannot be read counts as having no heading. `inform` lets the command run and logs the section; `require` refuses the command once per branch per session, with the section as the reason, until the PR body has an `## Impact` heading. It fails open: a git or `code_intel` error lets the command run. Dependents come from the indexed commit (shown as its 7-character commit) and undercount imports through `tsconfig` path aliases and `export *` barrels.
- **Spinner counts:** the `showAdoption` option, off by default. When on, the line that animates while a turn runs also shows the session's counts, for example `Sauteing · ✦ 5 code_intel / 1 grep…`: `code_intel` calls first, then symbol-like text searches, for the main conversation and subagents together. Nothing is added until one of the two is above zero, and the line is redrawn only when one of the two changes. Only the text after the spinner's word changes; the word, the timer and the token count stay Claude Code's own.
- **Version floor:** Claude Code 2.1.287. `hooks/hooks.json` keeps an empty `"hooks"` block beside `"modules"`, so older builds should still read it as a valid hooks file and simply run no hooks. This has not been tested on an older build.
- **Turn it off:** disable the plugin from `/plugin`, start Claude Code with `--safe-mode`, or set `disableAllHooks` in your settings.

## Data Handling

What the plugin runs, reads, and sends:

| Component | Runs / reads | Sends |
|-----------|--------------|-------|
| **MCP server** | Started with `npx -y @constellationdev/mcp@<pinned version>`, which downloads the package from the npm registry. Reads `constellation.json` and the current git branch from your project, and reads lines from local source files to attach code snippets to query results | Queries (symbol names, file paths, project ID, branch) to the Constellation API at `https://api.constellationdev.io`, or the self-hosted URL you configure via `CONSTELLATION_API_URL` or `constellation.json`, authenticated with `CONSTELLATION_ACCESS_KEY`. **Source code is never sent to the Constellation API.** Code snippets are returned only to Claude in the local session |
| **MCP server usage metrics** | Runs after each `code_intel` call. On by default; set `CONSTELLATION_USAGE_METRICS=false` to turn it off | A usage event (project ID, branch, which API methods ran, estimated token counts, durations) to the same Constellation API at `/intel/v1/usage`, or to `USAGE_ENDPOINT_URL` if you set it, authenticated with `CONSTELLATION_ACCESS_KEY`. Contains no source code, snippets, or symbol contents |
| **Hooks** (`hooks/register.ts`) | Run in-process in Claude Code. Calls: `$.clock.after` (retries a failed search result hint or impact lookup after a minute, re-reads a file's impact after five minutes, runs the onboarding's connection check after the session starts, and runs `reload-plugins` once the current handler has returned), `$.clock.now` (tells when the `code_intel` rows last read the theme and verbose settings, when the onboarding band last read the theme, and which local day an adoption count belongs to), `$.clock.sleep` (the search result hint's 2.5 second deadline, the impact gate's 3 second one, the turn summary's 2 second one and the PR impact section's 8 second one, and the one second the Stats tab waits for adoption counts still being saved), `$.command.register` (adds the `/constellation` command), `$.command.run` (runs `reload-plugins` after sign-in, or once when the session start's `ping` with a stored key is refused, so every plugin reloads and the Constellation MCP server starts with the key), `$.config.list` (reads Claude Code's theme to choose the pane's and `code_intel` rows' colors, and the verbose setting to show Claude Code's own `code_intel` rows under the summaries; the rows read both at most once a second, and again when either changes in `/config`; the onboarding band reads the theme at most once a second), `$.env.get` (reads `CONSTELLATION_ACCESS_KEY` and checks it starts with `ak:`), `$.env.set` (sets `CONSTELLATION_ACCESS_KEY` to the stored key), `$.fs.exists` (checks for `constellation.json` in the searched directory and its parents, whether a file about to be edited already exists, and, for the onboarding, the `.git` and `constellation.json` walk-up from the working directory and whether `/bin/sh` exists), `$.fs.read` (reads the `--body-file` of `gh pr create` to check for an Impact heading, and, before the session start's `ping` with a stored key, the project's `constellation.json`: the `ping` is skipped when its `apiUrl` is not `https://api.constellationdev.io` or the file cannot be read), `$.mcp.call` and `$.mcp.connect` (run the onboarding's `ping`, the search result hint's, the `/constellation` command's, the impact gate's, the turn summary's and the PR impact section's `code_intel` queries through the plugin's MCP server), `$.process.run` (the onboarding's login-shell `printenv CONSTELLATION_ACCESS_KEY` key read-back at the start of an interactive session, or `C:\Windows\System32\reg.exe query` where there is no `/bin/sh` (Windows), and, when you press Sign in or Index this project, `command -v constellation` in a plain and then a login `/bin/sh`, each printing that shell's `PATH`; the read-back's output passes through any plugin that hooks `process.run`. It also runs `git rev-parse`, `git symbolic-ref` and `git diff --name-only`, with the repository's fsmonitor, hooks, external diff and network fetches turned off, in the project root when Claude runs `gh pr create` inside the session's working directory), `$.process.spawn` (runs `constellation auth` and `constellation index --wait` when you press the onboarding band's Sign in or Index this project button; on Windows the band shows the command to run in a terminal instead), `$.prompt.fill` (drafts the removal prompt from the `/constellation` Unused picker, and the Explore tab's Ask Claude prompt, in the prompt box for you to edit and send), `$.session.cwd` (reads the working directory), `$.session.id` (names the session in the key its daily adoption counts are stored under), `$.session.surfaces` (checks whether the session can draw a pane or the onboarding band, or has someone to answer the impact dialog), `$.tool.check` (asks Claude Code what it would decide for an edit, so the impact gate knows whether you would be prompted anyway), `$.store.delete`, `$.store.get`, `$.store.keys` and `$.store.set` (remember, per folder, the project picked in the `/constellation` pane when that folder holds several projects, and, per repository, that you dismissed the onboarding band; keep the daily adoption counts, list them for the Stats tab and delete those older than 30 days, when the Stats tab reads them and on the first count of a session), `$.ui.ask` (asks before an auto-approved edit to a high-impact file, in dialog mode), `$.ui.close` (closes the `/constellation` pane), `$.ui.copy` (copies a symbol's file and line from the Explore tab), `$.ui.invalidate` (redraws the onboarding band when its state changes; also asks Claude Code to rebuild the search tool descriptions once, when the working directory first moves into an indexed project, to redraw the `/constellation` pane when its state or a query result changes, to redraw the `code_intel` rows when the theme or verbose setting changes, and, with `showAdoption` on, to redraw the spinner after a `code_intel` call or a symbol-like search is counted; one request redraws everything the plugin draws), `$.ui.log` (writes the onboarding's one line when the session cannot draw the band, notes an edit that was allowed because the impact dialog could not open, and in the PR impact section's `inform` mode logs that section after `gh pr create` runs), `$.ui.open` (opens the `/constellation` pane), `$.ui.resolve` (reads the element table the pane, the onboarding band and the `code_intel` tool rows are drawn with), `$.ui.toast` (shows the impact summary next to a permission prompt, and tells you when the onboarding band's sign-in connected or its indexing finished). For a Bash call they inspect the command Claude is about to run. The `/constellation` command sends `ping`, `getCapabilities`, `getDependencies`, `getDependents`, `findOrphanedCode`, `searchSymbols`, `getSymbolDetails`, `traceSymbolUsage`, `impactAnalysis` and `getCallGraph` queries through the MCP server (file paths, symbol names and symbol IDs only); `findOrphanedCode` now takes a kind filter and pages. The Unused picker's selection and the Explore tab's state are kept in memory only. A reminder count, the session's adoption counts, the symbols already hinted, the pane's state, the files you chose not to be asked about again, the files already assessed for each agent and, in `require-analysis` mode only, the paths and names each agent's `code_intel` impact queries asked about are kept in memory only. The onboarding band's state and the sign-in and index tasks in progress are kept in memory only. Three things are written to disk, all in this plugin's own store under `~/.claude/plugins/store/`: the picked project (the folder's path and the project's path, removed by switch project), the band's dismissal (the repository's path and the dismissed state, per repository) and the daily adoption counts (numbers only, under the date and the session's id: how many `code_intel` calls, their summed time, and how many symbol-like and literal text searches; no paths, search patterns or code; deleted after 30 days). The adoption counts never leave the machine. The onboarding runs no git subprocess: it finds the repository by looking for `.git` in the working directory and its parents. The key read-back's output passes through any plugin that hooks `process.run`, and the plugin reloads all plugins after sign-in | Nothing directly. They add `code_intel` reminders, guidance and search result hints to Claude's context; the hint's lookup is sent by the MCP server, as below |
| **Search result hint** (`hooks/augment.ts`, option `augmentGrep`, on by default) | Covers Grep and shell `grep`, `egrep`, `rg`, `ag`, `ack` and `git grep` searches. Reads the search pattern, and the identifier in it, from the call; never reads the search output | Only the identifier from the search pattern (for example `AuthService`), as `code_intel` `searchSymbols` queries through the MCP server above, the same as any `searchSymbols` query. Nothing from the search output is sent |
| **Impact gate** (`hooks/impact.ts`, `hooks/risk.ts`, option `impactGate`, off by default) | Reads the path of a file Claude is about to edit (`file_path`, or `notebook_path` for a notebook) and turns it into a path relative to the project root. In `dialog` and `native` modes it also reads the permission mode from each submitted prompt (`classic.UserPromptSubmit`), never the prompt's text | Only that project-relative file path, to `code_intel` `getDependents` (with the symbols each dependent imports) through the MCP server. Nothing from the file's contents |
| **Turn impact summary** (`hooks/turnsummary.ts`, `hooks/blast.ts`, option `turnSummary`, on by default) | Reads the paths of files Claude edits (`file_path`, or `notebook_path` for a notebook) and turns them into paths relative to the project root | Only project-relative paths, to `code_intel` `getDependents` through the MCP server. Nothing from the files' contents |
| **PR impact section** (`hooks/primpact.ts`, `hooks/blast.ts`, option `prImpact`) | Reads the `gh pr create` command, the PR body or body file, and the branch's changed file names from git | Only project-relative paths, to `code_intel` `getDependents` (with the symbols each dependent imports). Never the body text or file contents |
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
