# constellation-claude

Claude Code plugin (and its own marketplace) for Constellation. **Public repo.** Workspace architecture: `../AGENTS.md`.

## Quick Reference

| Task | Command |
|------|---------|
| Mod tests | `claude plugin test .` |
| Validate marketplace manifest | `claude plugin validate --strict .` |
| Validate plugin manifest + hooks module | `claude plugin validate --strict .claude-plugin/plugin.json` |
| Type-check | `tsc -p .` (load the plugin once first so the engine writes its tsconfig: `claude -p --plugin-dir . "ok"`) |
| Run locally | `claude --plugin-dir .` |

CI (`.github/workflows/test.yml`) runs the tests and both validates on the latest Claude Code, plus a grep that fails on any hex color literal outside `hooks/theme.ts`. CI does not run `tsc`: run all checks locally before pushing.

Validate on the plugin manifest prints every event the module hooks and every `$.*` call. The README Data Handling row must list exactly those `calls:`.

## Layout

| Path | What |
|------|------|
| `.claude-plugin/plugin.json` | Manifest; `userConfig` options: `nudgeLimit`, `augmentGrep`, `impactGate`, `impactThreshold`, `turnSummary`, `showFreshness`, `compactToolRows`, `showAdoption`, `prImpact` |
| `.claude-plugin/marketplace.json` | Marketplace listing (`source: ./`) |
| `.mcp.json` | MCP server keyed `constellation` (`npx @constellationdev/mcp`, stdio) |
| `commands/*.md` | Markdown slash commands: `status`, `diagnose`, `impact`, `deps`, `unused`, `architecture` |
| `skills/` | `constellation-troubleshooting` (+ `references/error-codes.md`), `impact-analysis` |
| `output-styles/code-intelligence.md` | Opt-in "Code Intelligence" output style |
| `hooks/hooks.json` | Empty `"hooks"` block beside `"modules": ["./register.ts"]` |
| `hooks/register.ts` | Module entry: one `registerX(on[, options])` call per handler file |
| `hooks/*.ts` / `*.test.ts` | In-process hooks module and co-located tests (`claude-code/testing`) |

Loading the plugin writes git-ignored `.claude-plugin/types/` (engine `.d.ts`) and a root `tsconfig.json` extending it.

### Hooks module files

| File | Feature |
|------|---------|
| `nudge.ts` | Session/subagent awareness text, search reminder |
| `budget.ts` | Per-agent nudge budget; the single code_intel observer |
| `classify.ts` | Search classifier (Grep pattern, Glob stem, Bash grep/rg), `ghPrCreate` |
| `describe.ts` | Search tool description guidance |
| `augment.ts` | One code_intel line after a symbol search |
| `adoption.ts` | Local code_intel vs text-search counter, spinner suffix |
| `session.ts` | All clear/resume/fork resets and `turn.complete` pruning |
| `risk.ts`, `impact.ts` | Impact gate (leaf `risk.ts` <- `budget.ts` <- `impact.ts`, one way) |
| `blast.ts`, `turnsummary.ts`, `primpact.ts` | Dependents probe, per-turn summary line, PR impact section |
| `toolrows.ts` | Compact code_intel transcript rows |
| `onboarding.ts`, `freshness.ts` | Above-prompt setup band, index freshness line |
| `command.ts`, `unused.ts`, `explore.ts` | `/constellation` command and six-tab pane |
| `explain.ts` | Error envelope to human-readable layout |
| `theme.ts` | Brand palette and drawing helpers (only file with color literals) |
| `lib.ts` | Shared helpers (`isConfigured`, `projectRoot`, `codeIntel`, `parseEnvelope`, ...) |

Design constraints and live-verified engine behavior for `hooks/`: `.claude/rules/hooks.md` (auto-loads for `hooks/**`).

## Conventions

- **No package.json, no build.** Commands, skills, output style are Markdown + YAML frontmatter, validated by running them in Claude Code.
- **Single MCP tool.** Everything goes through `mcp__plugin_constellation_constellation__code_intel`. Don't restate its API here; the MCP server instructions document it.
- **Commands:** `allowed-tools: mcp__plugin_constellation_constellation__code_intel` only, no `model:` override, and every command body includes `IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.`
- **Hooks module:** TypeScript ESM, static `import` only (no dynamic `import()`), types from `claude-code`, tab indentation. A new handler file exports `registerX(on, options?)` and gets one line in `register.ts`.
- **Gating:** every hook is `($, e, next)` and awaits `next(e)` first; features act only when `isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))` (key starts with `ak:`) and, where relevant, a `constellation.json` sits at or above the path (`projectRoot`).
- **Fail open.** A code_intel, git or store failure never blocks a tool call or edit; slow lookups race a deadline (`withinDeadline`).
- **User-facing text:** lines shown outside the pane start with `BRAND` (`✦ >_CONSTELLATION://CODE_INTEL`) + ` · ` via `branded()` / `brandMark()`. `✦` is never a status glyph (statuses: ✓ ⏱ ⚠ ✗ ℹ ·). Commands to run are written bare with the `const` shorthand (`run const auth`), never in backticks; the plugin itself still spawns `constellation`.

## Manual command check

```
/constellation                       # mod command: pane (status, diagnose, deps, unused, explore, stats)
/constellation:status
/constellation:diagnose
/constellation:impact <symbol-name> [file-path]
/constellation:deps <file-path> [--reverse]
/constellation:unused [kind]
/constellation:architecture
```

## Environment

```bash
const auth                    # store CONSTELLATION_ACCESS_KEY
const index --full            # full index of the project
```

Error codes and fixes: `skills/constellation-troubleshooting/references/error-codes.md`.

## Worktrees

Create git worktrees only under this repo's `.claude/worktrees/<branch-slug>` (already gitignored), e.g. `git worktree add .claude/worktrees/feat-x -b feat/x origin/main`. Never create them outside the repo (e.g. sibling `../constellation-<name>-<branch>` folders) or in a `.worktrees/` directory.
