# constellation-claude

**Role**: Claude Code plugin for Constellation code intelligence platform.
**See**: `../AGENTS.md` for workspace architecture.

## Plugin Structure

```
.claude-plugin/
├── plugin.json              Plugin manifest (name: constellation)
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
- **`classic.PreToolUse`** (matcher `{ tool: /^(Grep|Glob|Bash)$/ }`): for Grep and Glob, adds `REMINDER_TEXT`. For Bash, adds it only when the command contains `grep`, `rg`, `glob`, `awk`, or `findstr` as a whole word, case-insensitively, anywhere in the command (pipelines count).

Each handler returns `{ ...r, additionalContext: [...(r.additionalContext ?? []), TEXT] }`, where `r` is what `next(e)` returned. `additionalContext` is a `string[]`, one entry per hook, and spreading `r` keeps any `allow`, `ask`, or `deny` decision beneath. The text constants (`SESSION_TEXT`, `REMINDER_TEXT`) are exported from `hooks/nudge.ts`; keep them constant (no counts or paths) so the prompt cache stays valid.

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
- `$.tool.call` does not surface a `classic.PreToolUse` handler's `additionalContext`, so the PreToolUse tests capture the handler through a stand-in `on` and call it with a constructed envelope.

### Mods compatibility

Decisions that change behavior, verified on Claude Code 2.1.287 (macOS):

- **code_intel server.** `.mcp.json` keys the server `constellation`. The module calls `$.mcp.connect('constellation')` once and caches the name it returns; that name is what `$.mcp.call` takes. Loaded as a plugin it is `plugin:constellation:constellation`. When the same server already runs under another name (for example, working inside this repo with `--plugin-dir`, where `.mcp.json` also loads as a project server) connect returns that name instead, so never hard-code it. A refusal does not throw: the result says why (`reason`, `message`) and `codeIntel` reports it as `MCP_UNAVAILABLE`.
- **Version floor: Claude Code 2.1.287.** The hooks module needs a build that has function hooks. `claude plugin validate --strict` describes unrecognized manifest fields as issues "the runtime tolerates", so older builds should ignore `"modules"`. The settings hooks are retired, so an older build gets no nudges at all; this was not tested on an older build.
- **Command naming.** Mod commands (`$.command.register`) allow only letters, digits, `_` and `-` (up to 64), so a mod command cannot be spelled `constellation:status`. The Markdown commands list as `constellation:<name>`. A probe registered two commands and `$.command.list()` did not show them in the same turn, so whether a mod command gets a plugin prefix is not established. The register call returns the bare name, and a built-in's name is refused. No mod command is registered; this is documentation only.
- **Grep and Glob.** This native macOS build registers neither: `ToolSearch select:Grep,Glob` finds nothing, `tool.call` hooks saw only ToolSearch, Bash, and MCP tools while the model searched, and the generated `claude-code-tools/index.d.ts` has no entry for them. Search runs through Bash. Compare these names with `String(e.tool)` and write matchers (for example `/^(Grep|Glob|Bash)$/`) that type-check whether or not a build lists them.
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
