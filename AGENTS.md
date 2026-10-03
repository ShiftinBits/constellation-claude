# constellation-claude

**Role**: Claude Code plugin for Constellation code intelligence platform.
**See**: `../AGENTS.md` for workspace architecture.

## Plugin Structure

```
.claude-plugin/
├── plugin.json              Plugin manifest (name: constellation; userConfig: nudgeLimit, augmentGrep, colors)
└── marketplace.json         Registry listing (category: development)

.mcp.json                    MCP server config → mcp-constellation (stdio)
.claude/settings.local.json  Local enabled servers list

commands/                    6 slash commands (user-invoked)
├── status.md                API connectivity check
├── diagnose.md              Full health check
├── impact.md                Symbol change impact analysis
├── deps.md                  File dependency analysis
├── unused.md                Dead code finder
└── architecture.md          Codebase architecture overview

skills/
├── constellation-troubleshooting/
│   ├── SKILL.md             Troubleshooting guide (keyword-triggered)
│   └── references/
│       └── error-codes.md   Complete error code reference
└── impact-analysis/
    └── SKILL.md             Pre-change impact assessment guidance (keyword-triggered)

hooks/                       In-process hooks module (no settings hooks, no node scripts)
├── hooks.json               The "modules" entry that loads register.ts, beside an empty "hooks" block
├── register.ts              Hooks module entry: register(on, options), one call per handler file
├── nudge.ts                 code_intel awareness: classic.SessionStart, classic.SubagentStart, classic.PreToolUse
├── nudge.test.ts            Tests for nudge.ts (claude plugin test)
├── budget.ts                Per-session nudge budget: usedCodeIntelThisTurn, hasNudgeLeft, spendNudge, agentKey, resetBudgets, forgetAgentBudget; turn.start, tool.call
├── budget.test.ts           Tests for budget.ts (claude plugin test)
├── classify.ts              Search classifier: symbolOf, isSymbolLike, bashSearch, bashSearchPattern, globHasSymbolStem, searchTarget
├── classify.test.ts         Tests for classify.ts (claude plugin test)
├── describe.ts              Search tool description guidance: tool.describe, classic.CwdChanged
├── describe.test.ts         Tests for describe.ts (claude plugin test)
├── augment.ts               Search result augment: tool.call on Grep and Bash adds one code_intel line
├── augment.test.ts          Tests for augment.ts (claude plugin test)
├── session.ts               Session lifecycle: one classic.SessionStart reset (clear, resume, fork) and turn.complete pruning of subagent state
├── lib.ts                   Shared helpers: isConfigured, projectRoot, codeIntel, stringArg
├── lib.test.ts              Tests for lib.ts (claude plugin test)
├── command.ts               /constellation command and tabbed pane: registerCommand, parseArgs, summarize; session.start, command.run, ui.render, ui.close
├── command.test.ts          Tests for command.ts (claude plugin test)
├── theme.ts                 Brand theme leaf module: palette, rgb, MARK, Tone, Scheme, status, risk, kind, scheme, paint, forTheme, badge, buttonRow, gradientAt, banner, compactBanner
└── theme.test.ts            Tests for theme.ts (claude plugin test)

output-styles/
└── code-intelligence.md     "Code Intelligence" output style (opt-in via /config)
```

A session that loads the mod writes `.claude-plugin/types/` (generated `.d.ts` files and a tsconfig) and a root `tsconfig.json` that extends it. `.claude-plugin/types/` is git-ignored.

## Key Concepts

**Declarative plugin with a hooks module.** No package.json and no build step. Commands, skills, and the output style are Markdown files with YAML frontmatter. The hooks module (`hooks/register.ts` plus the handler files and helpers beside it) runs in-process inside Claude Code and is declared by the `"modules"` entry in `hooks/hooks.json`. There are no settings hooks and no node scripts. The module is TypeScript ES modules with static `import` declarations only, no dynamic `import()`, types from `claude-code` (`import type { Register } from 'claude-code'`), tab indentation. Each handler lives in its own file under `hooks/` and exports a function taking `on`; `register.ts` imports and calls it, one line per handler. Tests sit beside the code as `hooks/*.test.ts` and import from `claude-code/testing`. Commands and skills are still validated by running them in Claude Code.

**Single MCP tool** — All API calls flow through `mcp__plugin_constellation_constellation__code_intel`. Commands write JavaScript code blocks using an injected `api` object. The MCP server instructions (injected at system level) document all 11 API methods — do NOT duplicate that reference here.

## Component Patterns

### Commands

YAML frontmatter fields: `description`, `argument-hint` (optional), `allowed-tools`

```yaml
---
description: What it does
argument-hint: [arg1] [--flag]
allowed-tools: mcp__plugin_constellation_constellation__code_intel
---
```

- Arguments accessed via `$1`, `$2`, `$ARGUMENTS`
- All commands include: `"IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below."`
- Output is formatted presentation of API results
- All commands inherit the session model (no per-command `model:` override)

### Skills

YAML frontmatter fields: `name`, `description` (trigger keywords)

- Passive knowledge loaded when keywords match conversation
- Not actively invoked — supplements Claude's context
- Reference docs in `references/` subdirectory

| Skill | Triggers |
|-------|----------|
| constellation-troubleshooting | Constellation errors, MCP failures, AUTH_ERROR / PROJECT_NOT_INDEXED, etc. |
| impact-analysis | "I'm renaming / refactoring / deleting / moving X", "what would break if...", "is X safe to remove" |

### Hooks

All hooks live in the hooks module and run in-process. `hooks/nudge.ts` exports `registerNudges(on)`, which `register.ts` calls. Every handler is `($, e, next)`: it awaits `next(e)` first, then, only when `CONSTELLATION_ACCESS_KEY` starts with `ak:`, extends what came back.

- **`classic.SessionStart`**: adds `SESSION_TEXT`, establishing `code_intel` as the primary tool for code understanding. Fires for startup, clear, resume, and compact.
- **`classic.SubagentStart`**: adds the same `SESSION_TEXT` to spawned subagents (built-ins don't inherit AGENTS.md).
- **`classic.PreToolUse`** (matcher `{ tool: /^(Grep|Glob|Bash)$/ }`): adds `REMINDER_TEXT` only when all hold: the key starts with `ak:`; a `constellation.json` sits at or above the searched directory (`projectRoot`: the call's `path` for Grep and Glob when set; for Bash the search's path from `bashSearch`; else the session cwd); and the input is symbol-like, decided by `hooks/classify.ts`:
  - Grep: `isSymbolLike(pattern)`. A pattern is symbol-like when it is a bare identifier (`AuthService`, `get_user`), a declaration (`class X`, `interface X`, `function X`, `def X`, `func X`, `type X`), a call pattern (`X\(`), or a name in word boundaries (`\bX\b`). Quoted phrases and other text with whitespace, words with no lowercase letter (`TODO`, `FIXME`, `ERROR`, `MAX_RETRIES`), language keywords (`import`, `export`, `class`), regex with character classes, alternation or quantifiers, and keys containing `.` or `/` are not.
  - Glob: `globHasSymbolStem(pattern)`, true only when a segment that names what the glob matches (the last segment, and every segment from the first wildcard on) has a stem (before the first `*` or `.`) holding a PascalCase or camelCase token. A capitalized base directory (`/Users/me/proj/**/*.ts`) does not count, and extension globs such as `**/*.ts` never qualify.
  - Bash: `bashSearch(command)` gives `{ pattern, path }`, and `isSymbolLike(pattern)` decides. Only the leading command counts (up to the first unquoted `|`, `;`, `&&` or `||`), or the command after a leading `cd <dir> &&` (or `;`), which then searches under `<dir>`; leading variable assignments (`LC_ALL=C`) are skipped; and only when it is `grep`, `egrep`, `rg`, `ag`, `ack`, `git grep` or `git -C <dir> grep`. The path is the first operand after the pattern, joined under the `cd` or `-C` directory when relative. The pattern is the value of `-e` or `--regexp` (`-eFoo` and `--regexp=Foo` too), else the first argument that is neither a flag nor the value of a flag that takes one (`-A`, `-B`, `-C`, `-m`, `-t`, `-g`, `--type`, `--glob`, `--include` and the rest in `VALUE_FLAGS` and `LONG_VALUE_FLAGS`). Letters that take no value in grep (`-r`, `-G`, `-T`) are left out even where rg or ag give them one. The three tools share `searchTarget(e)` in `classify.ts`, which the search result augment uses too. A grep after a pipe filters output, so it never triggers, and `awk`, `findstr` and the word `glob` no longer trigger either.

- **`tool.describe`** (matcher `{ tool: /^(Grep|Glob|Bash)$/ }`, in `hooks/describe.ts`): when the key starts with `ak:` and a `constellation.json` sits in the session cwd or a parent, appends the constant `GUIDANCE` paragraph to the description from `next(e)`, keeping its `isDeferred`. Bash is included because native macOS and Linux builds register no Grep or Glob, so the Bash description is the only search tool description the model sees there. The engine asks once per tool per session and caches the answer, so the text must stay constant.
- **`classic.CwdChanged`**: when the last description was built with the gate closed, recomputes it for `e.new_cwd` and calls `$.ui.invalidate('tool.describe')` once it opens. Once the guidance is in, it stays (a module variable): it is harmless outside a project, and taking it out again would change the tools block, and so rewrite the whole prompt cache, every time Claude `cd`s out of and back into an indexed project. Nothing is invalidated per turn.

- **Nudge budget** (`hooks/budget.ts`, `registerBudget(on, options)`): `classic.PreToolUse` checks the read-only `usedCodeIntelThisTurn(e)` and `hasNudgeLeft(e)` before it walks the filesystem for `constellation.json`, and spends with `spendNudge(e)` last, after every condition holds. The session and subagent awareness text and the tool descriptions are never budgeted.
  - `nudgeLimit` is a `userConfig` option in `plugin.json` (number, default 3, minimum 0). `register(on, options)` passes `options` to `registerBudget`; users set it with `/config` or `claude plugin configure constellation`. In `claude plugin test`, `test(name, { options: { nudgeLimit: 2 } }, ...)` supplies it.
  - `usedCodeIntelThisTurn(e)` is a read-only predicate: the agent's last `code_intel` call happened in its current turn. `spendNudge(e)` returns false once `nudges >= nudgeLimit`, else counts one and returns true. Each does one job, so a search skipped for the same-turn rule spends nothing.
  - `turn.start` records `e.turnId` as the main conversation's current turn. `tool.call` with `{ tool: /code_intel$/ }` stamps the agent's budget with that turn. Every hook passes through with `next(e)`.
  - Lifecycle lives in `hooks/session.ts`, registered once (the events guide: register each event once per matcher): a `classic.SessionStart` hook with `{ source: ['clear', 'resume', 'fork'] }` calls `resetBudgets()` and `resetAugment()`; `startup` is a fresh process and `compact` keeps the state. Its matcher differs from `nudge.ts`'s unmatched `classic.SessionStart`, because validate refuses two hooks on one event without matchers. A `turn.complete` hook with `e.agentId` (a subagent's run ended) calls `forgetAgentBudget` and `forgetAgentLines`, so per-agent state does not grow for the whole session. Module variables, not `$.state`, so a module reload also starts everything over; that costs at most a few extra reminders.
  - Agent key: `'main'` when `e.agentId` is undefined, else `e.agentId`, so each subagent has its own budget (its context starts empty). The `e` of `classic.PreToolUse` is the bare `ToolCallEnvelope`, which declares no `agentId` (only `tool.call`'s adds it), so a second `tool.call` hook with `{ tool: /^(Grep|Glob|Bash)$/ }` records `tool_use_id -> agentId` for subagent calls while `next(e)` runs (`classic.PreToolUse` fires inside it), deletes the entry in `finally`, and the key lookup falls back to that map by `tool_use_id`. Keyed by call id because subagents run concurrently. This runtime nesting is taken from the types' description of the two events and covered by tests that raise them nested; it was not exercised in a live session.
  - Subagent turns: `turn.start` carries no `agentId`, but a subagent's whole run is one turn (its loop's `turn.complete` closes the run, per the types' `TurnCompleteFields`), so a subagent's turn is its `agentId`. A subagent that calls `code_intel` is not nudged for the rest of its run. When the run ends, its state is dropped, so a subagent continued later with SendMessage (same `agentId`, new run) starts with a fresh budget and turn.
  - State is module variables (`Map`s), not `$.state`, so a reload of the hooks module resets the budget. That is acceptable: the worst case is a few extra reminders. `registerBudget` also clears the state, which gives each test a fresh budget. A plugin the test kit loads is a separate module instance from the one a test file imports (verified: its `nudgeLimit` option reaches `registerBudget`, but a direct `spendNudge` import does not see its state), and a handler's added `classic.PreToolUse` context is not surfaced through `$.tool.call`. So `budget.test.ts` raises the registered handlers through a stand-in `on`, plus one loaded-plugin test with `options` that checks the hooks module loads with the option and the hooks pass through.

- **Search result augment** (`hooks/augment.ts`, `registerAugment(on, options)`): one `tool.call` hook with `{ tool: /^(Grep|Bash)$/ }`. Bash is included because native macOS and Linux builds have no Grep tool, so a Grep-only augment would never fire there. Before the search runs it returns `next(e)` untouched when: the key does not start with `ak:`; `searchTarget(e)` finds no identifier (the same classifier as the reminders); `usedCodeIntelThisTurn(e)` is true; `projectRoot` finds no `constellation.json` (Grep: its `path` when set, else the cwd; Bash: the cwd); or the line was already shown. Otherwise it starts the lookup, awaits `next(e)` (the search always runs), and returns `r` unchanged when `r.deny` or `r.isError` is set.
  - Lookup: `lookupSymbol(api, name)` is a real function, unit-tested against a stub `api`, and `lookupCode` sends its source (`fn.toString()`) to code_intel with the name through `JSON.stringify`, so the tested code is the code that runs. It reads a full page, `searchSymbols({ query, limit: 100, includeUsageCount: true, isExported: true })`, because `searchSymbols` matches substrings in name order and the exact name can sit far down it (`Organization` was 75th of core's unfiltered results). With no exported match it reads all symbols and keeps only used ones (an unused unexported match is usually a fixture). Of several exact matches it reports the most used and how many there were. It returns `{ name, kind, filePath, line, usages, definitions }`, or null.
  - Count: the graph's `usageCount` for the symbol. It counts uses through barrels and package aliases (13 for `GraphQueryService`, where `getDependents` on its file saw 1), in the same call.
  - Sharing and backoff: lookups are kept per project root and name in a module `Map` of promises, so parallel and repeated searches share one. A miss (null) stays for the session; a failure is dropped after `FAILURE_BACKOFF_MS` (one minute) with `$.clock.after`, so a down server costs one lookup a minute, not one per search.
  - Deadline: once the search finishes, the lookup races `$.clock.sleep(SOFT_DEADLINE_MS)`, `SOFT_DEADLINE_MS = 2500`, whose signal is `next.signal` combined with one the hook aborts once the race settles. A sleep that ends or rejects settles the race with no result, so the hook never rejects. A late lookup still settles into the map for the next search.
  - Output: one line, `✦ code_intel: <name> (<kind>) is defined at <filePath>:<line>, with <n> usages. Use code_intel for references, callers, and impact.` (`1 usage`; with several matches, `, the most used of <n> symbols with that name` after the location), appended as `{ ...r, context: [...(r.context ?? []), line] }`. `context` is what the model reads after the tool's result; keeping `r.result` and `r.ref` lets core reuse its own tool messages.
  - Dedupe: a module `Set` of agent key, project root and name. The hook claims its entry before it awaits, so two parallel searches show one line, and releases it when no line is shown. `resetAugment()` (from `session.ts` on `clear`, `resume` and `fork`) clears it and the lookups, and `forgetAgentLines(agentId)` drops a subagent's entries when its run ends. A failure's backoff timer deletes its key only if the map still holds that same promise, so a timer from before a reset never evicts a newer lookup. `registerAugment` clears both, so each load (and each loaded-plugin test) starts empty.
  - Budget: `usedCodeIntelThisTurn(e)` is the only budget check, read-only. The augment never calls `spendNudge` and is not limited by `nudgeLimit`; its own once-per-symbol rule bounds it. `tool.call` fires for every loop, so subagent searches are augmented too.
  - `augmentGrep` is a `userConfig` boolean (default true). `registerAugment` registers nothing when it is `false`; an unset value (a build that does not fill defaults) counts as on, as an unset `nudgeLimit` falls back to its default.

- **Brand theme** (`hooks/theme.ts`, a leaf module that imports only types from `claude-code` and never uses `$`): the only file allowed to hold color literals. Helpers take values or an element table (`$.ui.resolve(e)`), never `$`. Exports `palette` (hex strings), `rgb` (the five accents as integers for Raster cells), `MARK` (`✦`), `Tone`, `Scheme`, `status`, `risk`, `kind`, `scheme`, `paint`, `forTheme`, `badge`, `buttonRow`, `gradientAt`, `banner`, `compactBanner` and `BANNER_WIDTH`. Unknown input to `status`, `risk` and `kind` (callers pass strings from API data) falls back to a dim tone.
  - Terminal rules: no background colors and no muted-white text; primary text omits `color` and secondary text uses `dimColor`; never color alone, so every colored badge carries a word and a glyph; one `MARK` per tree; buttons are ordered cancel left, affirmative right, in a row with `justifyContent: 'flex-end'` and `columnGap: 2`, with no color props; padding and gap are 1; redraw only on state change and keep decorative motion at 2 fps or less. The last six palette entries (mutedSilver, terminalGray, mutedWhite, deepSpace, charcoal, dimOutline) are for Desktop Svg only.
  - `scheme(colors, theme)` picks the color scheme and `forTheme(tone, scheme)` / `paint(color, scheme)` apply it, the one place colors change by theme (see Colors under the `/constellation` command). Callers pass the option and the theme name; `theme.ts` never reads either.
  - `kind()` follows the brand reference (function and method nebula, class galactic, variable cosmic, import solar, error stellar) and adds these extensions:

    | Kind | Color | Source |
    |------|-------|--------|
    | interface, type | galactic | agrees with constellation-web graphTheme |
    | module | nebula | constellation-web graphTheme |
    | enum | galactic | extension |
    | property, constant | cosmic | extension |

  - constellation-web `graphTheme` swaps the variable and import colors relative to the brand reference; `theme.ts` follows the brand reference.

- **`/constellation` command and pane** (`hooks/command.ts`, `registerCommand(on)`): a zero-turn mod command, `immediate`, so it runs mid-turn and `command.run` returns without calling `next(e)` or the model.
  - Registration: `session.start` (a different event from the `classic.SessionStart` hooks) awaits `next(e)`, then calls `$.command.register` last inside try/catch with no retry, because a throwing register would skip the rest of the hook and a refusal must leave the Markdown commands working.
  - Run: `parseArgs` picks the tab (`status`, `diagnose`, `deps <file>`, `unused`; default status; no flags, the dependencies/dependents direction is a toggle in the pane). `canDraw(await $.session.surfaces())` decides the output: without a drawing surface it runs the tab's query and returns `{ text }` (a few Markdown lines from `summarize`, never a pane); with one it resets the pane state, reads the theme once from `$.config.list()` (the `theme` row) and, with the `colors` option, picks the color scheme (see Colors below), opens pane `constellation` with `focus` and `closeOnEscape`, and returns `{}`.
  - Queries: `codeIntel` with the cwd from `$.session.cwd()`: Status `api.ping()`, Diagnose `api.ping()` plus `api.getCapabilities()`, Deps `api.getDependencies` or `api.getDependents`, Unused `api.findOrphanedCode({})`. The file path goes into the code string through `JSON.stringify`. Each tab queries lazily on first show and caches its envelope in module state until Refresh or the pane closes.
  - Redraw: the pane state (selected tab, per-tab envelope cache, pending set, deps path and direction, theme) is module variables, so `ui.render` does not redraw on its own: every state change and every query completion calls `$.ui.invalidate('ui.render')`. A query that lands after its tab was dropped is discarded (a per-tab generation). When state is missing (a hot reload) `ui.render` draws the Status tab with nothing cached and starts its query; `ui.close` for the pane clears the state.
  - Presses and input run the controls' own callbacks, as the interface docs show: each tab `Button` sets the selected tab, Refresh drops the current tab's cache, Close calls `$.ui.close` and clears the pane state itself (the plugin's `ui.close` hook, which clears it for Esc and unload, does not see the plugin's own close from a callback), the direction toggle flips it and drops the Deps cache, a Deps row and the path `Input`'s `onSubmit` set the Deps path and drop its cache, and each ends with `$.ui.invalidate('ui.render')`. The plugin registers no `ui.press` or `ui.input` hook; those events are for other mods. Keys (what a test presses, and what `ui.press` reports): `tab-status`, `tab-diagnose`, `tab-deps`, `tab-unused` (hotkeys `1` to `4`), `refresh` (`r`), `close` (no hotkey; Esc is `closeOnEscape`), `deps-toggle`, `dep:<path>` per Deps row (no hotkey, so rows never clash with the digits), and `deps-path` for the `Input`.
  - One `summarize(tab, envelope, options)` feeds both outputs: it narrows the untyped `result` against the executor schemas and returns `items` (badges and rows the pane draws) and `lines` (the same facts as plain text). There is no second per-tab renderer. An error is the code as an `error` badge plus the message and each guidance line in `dimColor` (`AUTH_ERROR`, `PROJECT_NOT_INDEXED`, `CWD_NOT_INDEXED`, `API_UNREACHABLE` and the bridge codes `MCP_UNAVAILABLE`, `MCP_CALL_FAILED`, `INVALID_RESPONSE`, `MCP_TOOL_ERROR`); no onboarding buttons. Status shows connection and auth from `ping`, and the project name from the cwd; the branch is not in `ping`, so it appears only on Diagnose, from `getCapabilities`.
  - Project picker: when the session's working directory is not a project (a workspace root above several, such as this monorepo's root), code_intel answers `CWD_NOT_INDEXED` with `error.context.candidates`, which `codeIntel` keeps as `error.candidates`. The pane then draws a "Choose a project" heading and one pressable row per candidate (key `project:<path>`), with no error badge and none of the agent-facing guidance, and hides the tabs and Refresh until a pick, since every tab would ask the same question; a press runs every tab in that project. The pick is kept (module variable `chosen`, `{ from, root }`) across pane opens while the session stays in the directory it was picked from, so `/constellation` goes straight to it next time. The text fallback keeps the guidance, which names the candidates.
  - Picker details: each row is a keyed `Box` (hover scope) holding a plain `Button` and a dim `Text`. The Button has hotkey `1` to `9` (the tabs are hidden while picking, so the digits are free), `autoFocus` on the first row, and a `hover` of bold plus the accent color. The dim line comes from one `getCapabilities` query per project (`projectDetail`: indexed time, `supportedLanguages`, `fileCount`), run in parallel when the picker draws and dropped if the pane closes first. A pick is saved with `$.store.set('project:<from>', root)` and read back by `command.run`, so a later session opens straight into it; the header then shows the project name and a plain `p` button (key `switch-project`) that deletes the key and shows the list again. The header shows no switch control when the session's own directory is the project. Close carries `role: 'dismiss'`, which Desktop draws as its native close control.
  - Colors: the `colors` userConfig option (`brand`, the default, `theme` or `none`) and the `theme` row of `$.config.list()` give a `Scheme` through `scheme()` in `theme.ts`: `brand` on a dark or `auto` theme, `brand-light` on a light one (gold and green become the `warning` and `success` theme colors), `theme` on an ANSI or color-blind theme or when the option says so (the five accents become `suggestion`, `merged`, `warning`, `success` and `error`, the theme keys read from Claude Code's built-in themes), `none` when the option says so. `forTheme(tone, scheme)` and `paint(color, scheme)` apply it, including to the brand mark and the picker's hover; the word and glyph of every tone stay.
  - Layout: the CLI banner (`banner(el, tag, scheme)`, the art and gradient of `constellation-cli` `src/ui/banner.ts` and `colors.ts`, with the tag box reading `<project> › <tab>` or `choose a project`), then a dim row with the as-of commit, index age and the `p` switch control, then the tabs, a dim rule and a one-line description of the tab (`TAB_HINT`), then the body, then the buttons and a dim line naming the keys. The full banner needs `BANNER_WIDTH` (84) columns and a monospace grid, so the Desktop app and a pane narrower than that get `compactBanner` (the mark and spaced name along the gradient, then the tag). The gradient steps every three columns (`gradientAt`, from the CLI's RGB stops) to keep the tree small; on a light theme it keeps to the galactic and nebula stops, under `theme` it is the solid `suggestion` color (as the CLI draws solid blue without truecolor), and under `none` it has no color. Status and Diagnose draw labeled rows (`Item.label`): the label dim in a 13-column field, then a badge or the value; counts carry thousands separators.
  - Deps and Unused undercount files that import through tsconfig path aliases or `export *` barrels until the graph resolves them, which is why the metadata row always shows the `asOfCommit` (first 7 characters) and the indexed time.

Each `classic.*` handler returns `{ ...r, additionalContext: [...(r.additionalContext ?? []), TEXT] }`, where `r` is what `next(e)` returned. `additionalContext` is a `string[]`, one entry per hook, and spreading `r` keeps any `allow`, `ask`, or `deny` decision beneath. The text constants (`SESSION_TEXT`, `REMINDER_TEXT`) are exported from `hooks/nudge.ts`; keep them constant (no counts or paths) so the prompt cache stays valid.

## Development

### Adding a Command

1. Create `commands/<name>.md`
2. Add frontmatter: `description`, `allowed-tools: mcp__plugin_constellation_constellation__code_intel`, optional `argument-hint`
3. Include the "Do NOT invoke any skills" directive
4. Write JavaScript code block using `api.*` methods
5. Define output formatting for success and error cases

### Adding a Skill

1. Create `skills/<name>/SKILL.md` with frontmatter: `name`, `description` (trigger keywords)
2. Add reference docs in `skills/<name>/references/` if needed
3. Focus on diagnostic procedures and actionable guidance

### Modifying Hooks

Add a handler file under `hooks/` that exports a function taking `on` (for example `registerNudges(on: On)`), then import and call it from `hooks/register.ts`, one line per file. Read the key with the literal `$.env.get('CONSTELLATION_ACCESS_KEY')` (validate lists env names from literals) and pass the value to `isConfigured`. Compare tool names a build may not register (Grep, Glob) through `String(e.tool)`. Add a `hooks/<name>.test.ts` beside it using `claude-code/testing`:

- `$.classic.SessionStart(...)` and `$.classic.SubagentStart(...)` raise those events through the loaded plugin; answer the event beneath with `on('classic.SessionStart', () => ({}))` and set the key with `mock.env(on, { CONSTELLATION_ACCESS_KEY: 'ak:...' })`.
- `$.tool.describe({ tool, description, provider })` raises the description hook; the kit needs a base answer (`on('tool.describe', ...)`), and the handler's `$.session.cwd()` and `$.fs.exists(path)` are answered with `on('session.cwd', () => ({ value }))` and `on('fs.exists', ($, e) => ({ value }))`. Handlers beneath the plugin are always `($, e, next)`. Observe `$.ui.invalidate` with `on('ui.invalidate', ...)` returning `{ value: undefined }`; raise the cwd event with `$.classic.CwdChanged({ old_cwd, new_cwd })`.
- `$.tool.call` does not surface a `classic.PreToolUse` handler's `additionalContext`, so the PreToolUse tests capture the handler through a stand-in `on` and call it with a constructed envelope.
- A `tool.call` hook's `context` is surfaced: `$.tool.call(...)` resolves to the `ToolCallResult` the hooks returned. Answer the tool itself with one `on('tool.call', ...)` (registering it twice fails the load), and a Bash call also needs `on('classic.PreToolUse', () => ({}))` beneath. The handler's `$.mcp.connect` and `$.mcp.call` are answered with `on('mcp.connect', () => ({ value: { isConnected: true, server } }))` and `on('mcp.call', ($, e) => ({ value: mcpToolResult }))`; `mock.clock(on)` holds `$.clock.sleep` until `clock.advance(ms)`. The kit raises `{ tool: 'Grep', ... }` although this build's tool table has no Grep, so that input is cast to `ToolCallArgs` for tsc.

### Mods compatibility

Decisions that change behavior, verified on Claude Code 2.1.287 (macOS):

- **code_intel server.** `.mcp.json` keys the server `constellation`. The module calls `$.mcp.connect('constellation')` before every call (it answers at once for a connected server) and passes the name it returns to `$.mcp.call`, so a restarted or renamed server is picked up with no cache to go stale. A result with `isError` set keeps code_intel's own error envelope when it carries one, else becomes `MCP_TOOL_ERROR`; it is never read as a success. Loaded as a plugin it is `plugin:constellation:constellation`. When the same server already runs under another name (for example, working inside this repo with `--plugin-dir`, where `.mcp.json` also loads as a project server) connect returns that name instead, so never hard-code it. A refusal does not throw: the result says why (`reason`, `message`) and `codeIntel` reports it as `MCP_UNAVAILABLE`.
- **Version floor: Claude Code 2.1.287.** The hooks module needs a build that has function hooks. `claude plugin validate --strict` describes unrecognized manifest fields as issues "the runtime tolerates", so older builds should ignore `"modules"`. `hooks/hooks.json` keeps an empty `"hooks"` block beside it (the reference allows both), so a build that requires the `"hooks"` wrapper still reads a valid, empty hooks file. The settings hooks are retired, so an older build gets no nudges at all; this was not tested on an older build.
- **Command naming.** Probed on Claude Code 2.1.288 (macOS) with a minimal `session.start` hook run through `claude --plugin-dir .`: `$.command.register({ name: 'constellation', ... })` resolves `{ command: 'constellation' }` (bare). The `/` menu lists `/constellation` beside the Markdown `/constellation:deps`, `:status`, `:unused` and `:impact` with no conflict, `$.command.list()` reports the mod command as `constellation` (source `plugin`), typing `/constellation` runs the mod command (no model turn) and the Markdown commands still list. So `COMMAND = 'constellation'`. Mod command names allow only letters, digits, `_` and `-` (up to 64), so no colon; a built-in's name is refused. Register last inside try/catch with no retry: a throwing `$.command.register` skips the rest of the `session.start` hook. The `theme` row of `$.config.list()` is a `choice` with options `auto`, `dark`, `light`, `light-daltonized`, `dark-daltonized`, `light-ansi`, `dark-ansi` (current value observed: `dark`), so a value starting with `light` is the light family and `auto` reads as dark. Not verified: the name when the plugin is installed (not loaded with `--plugin-dir`), a light theme in a live session, and a press on a Deps row in a live session; the pane, tab hotkeys (`2`, `4`), Esc and `/constellation deps <file>` were run live in an indexed project on the dark theme.
- **Tool descriptions reach subagents.** `tool.describe` has no `agentId`; the rewritten description is the session's, cached until `$.ui.invalidate("tool.describe")`. Confirmed in a throwaway `--plugin-dir` session in an indexed project: an Explore subagent asked to quote its Bash description returned the paragraph with the `GUIDANCE` text.
- **Cwd changes.** The classic `CwdChanged` event (`classic.CwdChanged`, input `old_cwd` and `new_cwd`) exists in the types, so the description gate is re-checked when the working directory moves. The open-once invalidation is covered by unit tests; it was not exercised in a live session.
- **Grep and Glob.** This native macOS build registers neither: `ToolSearch select:Grep,Glob` finds nothing, `tool.call` hooks saw only ToolSearch, Bash, and MCP tools while the model searched, and the generated `claude-code-tools/index.d.ts` has no entry for them. Search runs through Bash. Compare these names with `String(e.tool)` and write matchers (for example `/^(Grep|Glob|Bash)$/`) that type-check whether or not a build lists them.
- **`tool.call` context reaches the model.** A `tool.call` hook that returns `{ ...r, context: [...] }` adds a reminder the model reads after the tool's result, with core's own messages kept through `r.ref`. Confirmed live with the search result augment (see Hooks), so the search output itself is never rewritten.
- **`$.fs.ancestors` is `.md` only.** It rejects any other name (`takes names, each a .md file name`), so it cannot find `constellation.json`. `projectRoot` walks up with `$.fs.exists` instead.
- **`$` does not cross imports.** `claude plugin validate` follows `$` only into functions declared in the same file and rejects `isConfigured($)` for a function imported from `lib.ts`. Helpers in `lib.ts` take values or closures; the handler spells each call: `isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))`, `projectRoot(await $.session.cwd(), (p) => $.fs.exists(p))`, `codeIntel({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, code, { cwd })`. This keeps validate's `calls:` list, which the README Data Handling row must match exactly, complete.
- **Test kit scope.** The `$` a test receives has the engine's events (`$.tool.call`, `$.session.start`, ...) and `mock.env`, `mock.clock`, `mock.store`; it has no `$.mcp`, `$.fs`, or `$.env.get`, and a test has no file system. Helper tests pass plain fakes for the closures.

### Testing

Run from the plugin root. `claude plugin validate` on the root checks only the marketplace manifest, so also point it at the plugin manifest to check the hooks module (it lists what the module hooks and calls):

```bash
claude plugin validate --strict .
claude plugin validate --strict .claude-plugin/plugin.json
claude plugin test .
tsc -p .                # needs the engine-written tsconfig: load the plugin once first
                        # (e.g. claude -p --plugin-dir . "ok")
```

There is no CI workflow; run these locally before opening a PR. Validate the commands manually:

```
/constellation:status
/constellation:diagnose
/constellation:impact <symbol> <file>
/constellation:deps <file> [--reverse]
/constellation:unused [--kind function|class|type]
/constellation:architecture
```

## Environment

```bash
constellation auth                    # Configure CONSTELLATION_ACCESS_KEY
constellation index --full            # Index project
constellation index --full --force    # Force reindex
```

## Error Codes

| Code | Cause | Fix |
|------|-------|-----|
| `AUTH_ERROR` | Missing/invalid API key | `constellation auth` |
| `PROJECT_NOT_INDEXED` | Project needs indexing | `constellation index --full` |
| `SYMBOL_NOT_FOUND` | Typo or stale index | Broader search or re-index |
| `API_UNREACHABLE` | API not running | Check network / API URL in `constellation.json` |

See `skills/constellation-troubleshooting/references/error-codes.md` for full reference.
