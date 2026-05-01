# constellation-claude

**Role**: Claude Code plugin for Constellation code intelligence platform.
**See**: `../AGENTS.md` for workspace architecture.

## Plugin Structure

```
.claude-plugin/
├── plugin.json              Plugin manifest (name: constellation, v1.2.3)
└── marketplace.json         Registry listing (category: development)

.mcp.json                    MCP server config → mcp-constellation (stdio)
.claude/settings.local.json  Local enabled servers list

commands/                    6 slash commands (user-invoked)
├── status.md                API connectivity check (model: haiku)
├── diagnose.md              Full health check (model: haiku)
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

hooks/                       SessionStart, SubagentStart, PreToolUse (Grep|Glob, Bash)
├── hooks.json               Hook registrations
├── inject.js                Static context injector (SessionStart, SubagentStart, PreToolUse)
└── bash.js                  Bash-command sniffer that nudges code_intel for grep/rg/glob/awk/findstr

output-styles/
└── code-intelligence.md     "Code Intelligence" output style (opt-in via /config)
```

## Key Concepts

**Pure declarative plugin** — No package.json, no build step, no tests. All components are Markdown files with YAML frontmatter. Validation is manual (run commands in Claude Code).

**Single MCP tool** — All API calls flow through `mcp__plugin_constellation_constellation__code_intel`. Commands write JavaScript code blocks using an injected `api` object. The MCP server instructions (injected at system level) document all 10 API methods — do NOT duplicate that reference here.

## Component Patterns

### Commands

YAML frontmatter fields: `description`, `argument-hint` (optional), `allowed-tools`, `model` (optional: `haiku` or inherit)

```yaml
---
description: What it does
argument-hint: [arg1] [--flag]
allowed-tools: mcp__plugin_constellation_constellation__code_intel
model: haiku
---
```

- Arguments accessed via `$1`, `$2`, `$ARGUMENTS`
- All commands include: `"IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below."`
- Output is formatted presentation of API results
- `status` and `diagnose` use `model: haiku` (lightweight); others inherit session model

### Skills

YAML frontmatter fields: `name`, `description` (trigger keywords)

- Passive knowledge loaded when keywords match conversation
- Not actively invoked — supplements Claude's context
- Reference docs in `references/` subdirectory

| Skill | Triggers |
|-------|----------|
| constellation-troubleshooting | Constellation errors, MCP failures, AUTH_ERROR / PROJECT_NOT_INDEXED, etc. |
| impact-analysis | "I'm renaming / deleting / refactoring X", "what would break if...", "is X dead code" |

### Hooks

JSON structure in `hooks/hooks.json`. Three events, four matchers, all `type: "command"` shelling out to Node scripts in `hooks/`:

- **SessionStart** (`matcher: ".*"`): Runs `inject.js SessionStart`, which emits `hookSpecificOutput.additionalContext` establishing `code_intel` as the primary tool for code understanding. Gated on `CONSTELLATION_ACCESS_KEY` starting with `ak:`.
- **SubagentStart** (`matcher: ".*"`): Runs `inject.js SubagentStart` to inject the same code_intel awareness into spawned subagents (built-ins don't inherit AGENTS.md).
- **PreToolUse** `Grep|Glob` matcher: Runs `inject.js PreToolUse` to remind Claude to prefer `code_intel` for structural queries before falling back to text search.
- **PreToolUse** `Bash` matcher: Runs `bash.js`, which inspects `tool_input.command` and emits the same reminder when the command starts with `grep`/`rg`/`glob`/`awk`/`findstr` (and isn't part of a pipeline).

## Development

### Adding a Command

1. Create `commands/<name>.md`
2. Add frontmatter: `description`, `allowed-tools: mcp__plugin_constellation_constellation__code_intel`, optional `argument-hint`, `model`
3. Include the "Do NOT invoke any skills" directive
4. Write JavaScript code block using `api.*` methods
5. Define output formatting for success and error cases

### Adding a Skill

1. Create `skills/<name>/SKILL.md` with frontmatter: `name`, `description` (trigger keywords)
2. Add reference docs in `skills/<name>/references/` if needed
3. Focus on diagnostic procedures and actionable guidance

### Modifying Hooks

Edit `hooks/hooks.json`. Hook entries use `type: "command"` and shell out to Node scripts in `hooks/`. To inject context, scripts write `{"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"..."}}` to stdout (per the [Claude Code hooks spec](https://code.claude.com/docs/en/hooks)). The shared `inject.js` handles `SessionStart`, `SubagentStart`, and `PreToolUse`; `bash.js` handles the `Bash` matcher and reads `tool_input.command` from stdin.

### Testing

No automated tests. Validate manually:

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
