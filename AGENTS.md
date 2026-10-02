# constellation-claude

**Role**: Claude Code plugin for Constellation code intelligence platform.
**See**: `../AGENTS.md` for workspace architecture.

## Plugin Structure

```
.claude-plugin/
├── plugin.json              Plugin manifest (name: constellation; userConfig: nudgeLimit, augmentGrep)
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
├── hooks.json               The "modules" entry that loads register.ts
├── register.ts              Hooks module entry: register(on, options), one call per handler file
├── nudge.ts                 code_intel awareness: classic.SessionStart, classic.SubagentStart, classic.PreToolUse
├── nudge.test.ts            Tests for nudge.ts (claude plugin test)
├── budget.ts                Per-session nudge budget: usedCodeIntelThisTurn, spendNudge; turn.start, tool.call, classic.SessionStart
├── budget.test.ts           Tests for budget.ts (claude plugin test)
├── classify.ts              Search classifier: symbolOf, isSymbolLike, bashSearchPattern, globHasSymbolStem
├── classify.test.ts         Tests for classify.ts (claude plugin test)
├── describe.ts              Search tool description guidance: tool.describe, classic.CwdChanged
├── describe.test.ts         Tests for describe.ts (claude plugin test)
├── augment.ts               Search result augment: tool.call on Grep and Bash adds one code_intel line
├── augment.test.ts          Tests for augment.ts (claude plugin test)
├── lib.ts                   Shared helpers: isConfigured, projectRoot, codeIntel, canDraw
└── lib.test.ts              Tests for lib.ts (claude plugin test)

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
- **`classic.PreToolUse`** (matcher `{ tool: /^(Grep|Glob|Bash)$/ }`): adds `REMINDER_TEXT` only when all hold: the key starts with `ak:`; a `constellation.json` sits at or above the searched directory (`projectRoot`: the call's `path` for Grep and Glob when set, else the session cwd; Bash uses the cwd); and the input is symbol-like, decided by `hooks/classify.ts`:
  - Grep: `isSymbolLike(pattern)`. A pattern is symbol-like when it is a bare identifier (`AuthService`, `get_user`), a declaration (`class X`, `interface X`, `function X`, `def X`, `func X`, `type X`), a call pattern (`X\(`), or a name in word boundaries (`\bX\b`). Quoted phrases and other text with whitespace, words with no lowercase letter (`TODO`, `FIXME`, `ERROR`, `MAX_RETRIES`), regex with character classes, alternation or quantifiers, and keys containing `.` or `/` are not.
  - Glob: `globHasSymbolStem(pattern)`, true only when a path segment's stem (before the first `*` or `.`) holds a PascalCase or camelCase token. Extension globs such as `**/*.ts` never qualify.
  - Bash: `isSymbolLike(bashSearchPattern(command) ?? '')`. Only the leading command counts (up to the first unquoted `|`, `;`, `&&` or `||`), and only when it is `grep`, `egrep`, `rg`, `ag`, `ack` or `git grep`. The pattern is the value of `-e` or `--regexp`, else the first argument not starting with `-`; other value-taking flags are not modeled. A grep after a pipe filters output, so it never triggers, and `awk`, `findstr` and the word `glob` no longer trigger either.

- **`tool.describe`** (matcher `{ tool: /^(Grep|Glob|Bash)$/ }`, in `hooks/describe.ts`): when the key starts with `ak:` and a `constellation.json` sits in the session cwd or a parent, appends the constant `GUIDANCE` paragraph to the description from `next(e)`, keeping its `isDeferred`. Bash is included because native macOS and Linux builds register no Grep or Glob, so the Bash description is the only search tool description the model sees there. The engine asks once per tool per session and caches the answer, so the text must stay constant.
- **`classic.CwdChanged`**: recomputes the same gate for `e.new_cwd` and calls `$.ui.invalidate('tool.describe')` only when the result differs from the one the last description was built under (a module variable). Nothing is invalidated per turn.

- **Nudge budget** (`hooks/budget.ts`, `registerBudget(on, options)`): `classic.PreToolUse` spends from it only after every condition above holds, and last: `if (usedCodeIntelThisTurn(e) || !spendNudge(e)) return r`. The session and subagent awareness text and the tool descriptions are never budgeted.
  - `nudgeLimit` is a `userConfig` option in `plugin.json` (number, default 3, minimum 0). `register(on, options)` passes `options` to `registerBudget`; users set it with `/config` or `claude plugin configure constellation`. In `claude plugin test`, `test(name, { options: { nudgeLimit: 2 } }, ...)` supplies it.
  - `usedCodeIntelThisTurn(e)` is a read-only predicate: the agent's last `code_intel` call happened in its current turn. `spendNudge(e)` returns false once `nudges >= nudgeLimit`, else counts one and returns true. Each does one job, so a search skipped for the same-turn rule spends nothing.
  - `turn.start` records `e.turnId` as the current turn. `tool.call` with `{ tool: /code_intel$/ }` stamps the agent's budget with that turn. A `classic.SessionStart` hook with `{ source: ['clear', 'resume', 'fork'] }` clears every budget; `startup` is a fresh process and `compact` keeps the budget. Every hook passes through with `next(e)`. A separate `classic.SessionStart` hook lives in `budget.ts` so `nudge.ts` only consults it; the two have different matchers because validate refuses two hooks on one event without matchers.
  - Agent key: `'main'` when `e.agentId` is undefined, else `e.agentId`, so each subagent has its own budget (its context starts empty). The `e` of `classic.PreToolUse` is the bare `ToolCallEnvelope`, which declares no `agentId` (only `tool.call`'s adds it), so a second `tool.call` hook with `{ tool: /^(Grep|Glob|Bash)$/ }` records `tool_use_id -> agentId` for subagent calls while `next(e)` runs (`classic.PreToolUse` fires inside it), deletes the entry in `finally`, and the key lookup falls back to that map by `tool_use_id`. Keyed by call id because subagents run concurrently. This runtime nesting is taken from the types' description of the two events and covered by tests that raise them nested; it was not exercised in a live session.
  - Limit of the types, verified against the generated declarations: `turn.start` carries only `text` and `turnId`, no `agentId`, so turns are tracked for `'main'` only. A subagent's `code_intel` call finds no current turn and does not silence its later searches; its per-agent count still applies.
  - State is module variables (`Map`s), not `$.state`, so a reload of the hooks module resets the budget. That is acceptable: the worst case is a few extra reminders. `registerBudget` also clears the state, which gives each test a fresh budget. A plugin the test kit loads is a separate module instance from the one a test file imports (verified: its `nudgeLimit` option reaches `registerBudget`, but a direct `spendNudge` import does not see its state), and a handler's added `classic.PreToolUse` context is not surfaced through `$.tool.call`. So `budget.test.ts` raises the registered handlers through a stand-in `on`, plus one loaded-plugin test with `options` that checks the hooks module loads with the option and the hooks pass through.

- **Search result augment** (`hooks/augment.ts`, `registerAugment(on, options)`): one `tool.call` hook with `{ tool: /^(Grep|Bash)$/ }`. Bash is included because native macOS and Linux builds have no Grep tool, so a Grep-only augment would never fire there. It awaits `next(e)` first, so the search always runs, then returns `r` unchanged when: `r.deny` or `r.isError` is set; the key does not start with `ak:`; `symbolOf` finds no identifier (Grep: `pattern`; Bash: `bashSearchPattern(command)`, the same classifier as the reminders); the identifier is already in the module `Set` `augmented`; `usedCodeIntelThisTurn(e)` is true; or `projectRoot` finds no `constellation.json` (Grep: its `path` when set, else the cwd; Bash: the cwd).
  - Lookup: one `codeIntel` call with `cwd` set to the project root. The code runs `api.searchSymbols({ query: NAME, limit: 3 })`, takes the exact-name match, then `api.getDependents({ filePath, includeSymbols: true })` and counts the dependent files whose `usedSymbols` hold the name or `'*'` (a barrel re-export). It returns `{ name, kind, filePath, line, dependents }`, or null without an exact match. The identifier enters the code once, through `JSON.stringify`. `getDependents` is file-scoped, so it takes the symbol's `filePath`; `impactAnalysis({ symbolId })` would give a symbol-level count but took about 12 s against about 1.3 s for `getDependents` on core, far past the deadline.
  - Deadline: the lookup races `$.clock.sleep(SOFT_DEADLINE_MS, { signal: next.signal })`, `SOFT_DEADLINE_MS = 2500`, one constant that allows for a cold MCP start. A sleep that ends or rejects (the signal aborted) settles the race with no result, so the hook never rejects; the search result comes back unchanged.
  - Output: one line, `✦ code_intel: <name> is a <kind> at <filePath>:<line> (<n> dependents). Use code_intel for references, callers, and impact.`, appended as `{ ...r, context: [...(r.context ?? []), line] }`. `context` is what the model reads after the tool's result; keeping `r.result` and `r.ref` lets core reuse its own tool messages. Confirmed in a throwaway `--plugin-dir` session in core: `rg -l SearchSymbolsExecutor ...` returned the line to the model with the class, its file and line, and 4 dependents.
  - Dedupe: the identifier joins `augmented` only after a successful augment, so an error, a timeout or no exact match leaves it for a later search. `registerAugment` clears the set, so each load (and each loaded-plugin test) starts empty.
  - Budget: `usedCodeIntelThisTurn(e)` is the only budget check, read-only. The augment never calls `spendNudge` and is not limited by `nudgeLimit`; its own once-per-identifier rule bounds it. `tool.call` fires for every loop, so subagent searches are augmented too.
  - `augmentGrep` is a `userConfig` boolean (default true). `registerAugment` registers nothing when it is `false`; an unset value (a build that does not fill defaults) counts as on, as an unset `nudgeLimit` falls back to its default.

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

- **code_intel server.** `.mcp.json` keys the server `constellation`. The module calls `$.mcp.connect('constellation')` once and caches the name it returns; that name is what `$.mcp.call` takes. Loaded as a plugin it is `plugin:constellation:constellation`. When the same server already runs under another name (for example, working inside this repo with `--plugin-dir`, where `.mcp.json` also loads as a project server) connect returns that name instead, so never hard-code it. A refusal does not throw: the result says why (`reason`, `message`) and `codeIntel` reports it as `MCP_UNAVAILABLE`.
- **Version floor: Claude Code 2.1.287.** The hooks module needs a build that has function hooks. `claude plugin validate --strict` describes unrecognized manifest fields as issues "the runtime tolerates", so older builds should ignore `"modules"`. The settings hooks are retired, so an older build gets no nudges at all; this was not tested on an older build.
- **Command naming.** Mod commands (`$.command.register`) allow only letters, digits, `_` and `-` (up to 64), so a mod command cannot be spelled `constellation:status`. The Markdown commands list as `constellation:<name>`. A probe registered two commands and `$.command.list()` did not show them in the same turn, so whether a mod command gets a plugin prefix is not established. The register call returns the bare name, and a built-in's name is refused. No mod command is registered; this is documentation only.
- **Tool descriptions reach subagents.** `tool.describe` has no `agentId`; the rewritten description is the session's, cached until `$.ui.invalidate("tool.describe")`. Confirmed in a throwaway `--plugin-dir` session in an indexed project: an Explore subagent asked to quote its Bash description returned the paragraph with the `GUIDANCE` text.
- **Cwd changes.** The classic `CwdChanged` event (`classic.CwdChanged`, input `old_cwd` and `new_cwd`) exists in the types, so the description gate is re-checked when the working directory moves. The flip-only invalidation is covered by unit tests; it was not exercised in a live session.
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
