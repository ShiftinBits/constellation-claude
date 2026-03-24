# constellation-claude

**Role**: Claude Code plugin for Constellation code intelligence platform.
**See**: `../CLAUDE.md` for workspace architecture.

## Plugin Structure

```
.claude-plugin/
├── plugin.json              Plugin manifest (name: constellation, v1.0.0)
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

agents/                      3 autonomous agents (Claude-triggered)
├── source-scout.md          Codebase exploration (blue, tools: MCP+Read+Grep+Glob)
├── impact-investigator.md   Change risk assessment (yellow, tools: MCP+Read+Grep+Glob)
└── dependency-detective.md  Dependency health (cyan, tools: MCP+Read+Grep+Glob)

skills/
└── constellation-troubleshooting/
    ├── SKILL.md             Troubleshooting guide (keyword-triggered)
    └── references/
        └── error-codes.md   Complete error code reference

hooks/hooks.json             4 hooks (SessionStart, SubagentStart, PreToolUse, PreCompact)

output-styles/
└── code-intelligence.md     "Code Intelligence" output style (opt-in via /config)
```

## Key Concepts

**Pure declarative plugin** — No package.json, no build step, no tests. All components are Markdown files with YAML frontmatter. Validation is manual (run commands in Claude Code).

**Single MCP tool** — All API calls flow through `mcp__plugin_constellation_constellation__code_intel`. Commands and agents write JavaScript code blocks using an injected `api` object. The MCP server instructions (injected at system level) document all 10 API methods — do NOT duplicate that reference here.

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

### Agents

YAML frontmatter fields: `name`, `description` (with `<example>` trigger blocks), `model`, `color`, `tools`

```yaml
---
name: agent-name
description: Purpose + <example> blocks showing when Claude should trigger
model: inherit
color: blue
tools: ["mcp__plugin_constellation_constellation__code_intel", "Read", "Glob", "Grep"]
---
```

- Claude's LLM evaluates conversation context against `<example>` blocks to decide when to trigger
- All agents have **graceful degradation**: fall back to Grep/Glob/Read if MCP unavailable
- Error handling is tiered: MCP failure → API error → query error (each has different fallback)

| Agent | Color | Triggers | Tools |
|-------|-------|----------|-------|
| source-scout | blue | "What does X do?", "Where is X?" | MCP, Read, Grep, Glob |
| impact-investigator | yellow | "I'm renaming/deleting/changing X" | MCP, Read, Grep, Glob |
| dependency-detective | cyan | "Are modules coupled?", "Check imports" | MCP, Read, Grep, Glob |

### Skills

YAML frontmatter fields: `name`, `description` (trigger keywords), `version`

- Passive knowledge loaded when keywords match conversation
- Not actively invoked — supplements Claude's context
- Reference docs in `references/` subdirectory

### Hooks

JSON structure in `hooks/hooks.json`. Four hooks:

- **SessionStart** (`matcher: "startup"`): Injects Constellation MCP awareness at session start. Establishes `code_intel` as the primary tool for code understanding.
- **SubagentStart** (`matcher: "Explore|Plan"`): Injects Constellation MCP awareness into built-in Explore and Plan subagents. Instructs them to prefer `code_intel` over Grep/Glob for structural code questions (symbol definitions, callers/callees, dependencies, impact analysis). Built-in subagents don't inherit CLAUDE.md, so this hook bridges the gap.
- **PreToolUse** (`matcher: "Grep|Glob"`): Reminds Claude to prefer `code_intel` for structural queries before falling back to text search. Allows Grep/Glob for literal string search and config values.
- **PreCompact** (`matcher: ".*"`): Tells Claude to preserve architectural insights, dependency relationships, and impact analysis results during context compaction

## Development

### Adding a Command

1. Create `commands/<name>.md`
2. Add frontmatter: `description`, `allowed-tools: mcp__plugin_constellation_constellation__code_intel`, optional `argument-hint`, `model`
3. Include the "Do NOT invoke any skills" directive
4. Write JavaScript code block using `api.*` methods
5. Define output formatting for success and error cases

### Adding an Agent

1. Create `agents/<name>.md`
2. Add frontmatter: `name`, `description` with `<example>` trigger blocks, `model: inherit`, `color`, `tools` array
3. Write system prompt with responsibilities, API usage, output format
4. Include tiered error handling section (MCP unavailable → API error → query error)
5. Ensure graceful degradation to Grep/Glob/Read

### Adding a Skill

1. Create `skills/<name>/SKILL.md` with frontmatter: `name`, `description` (trigger keywords), `version`
2. Add reference docs in `skills/<name>/references/` if needed
3. Focus on diagnostic procedures and actionable fixes

### Modifying Hooks

Edit `hooks/hooks.json`. Available events: `SubagentStart`, `PreCompact`, `SessionStart`, `PreToolUse`, `PostToolUse`. Hook type: `prompt` (AI-evaluated instruction).

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
