# constellation-claude

Claude Code plugin (and its own marketplace) for Constellation. **Public repo.** Workspace architecture: `../AGENTS.md`.

## Quick Reference

| Task | Command |
|------|---------|
| Mod tests | `claude plugin test .` |
| Validate marketplace, plugin and hooks module | `claude plugin validate --strict .` |
| Validate as a directory submission | `claude plugin validate --profile directory --strict .` (latest Claude Code only; the floor has no `--profile`) |
| Type-check | `tsc -p .` (load the plugin once first so the engine writes its tsconfig: `claude -p --plugin-dir . "ok"`) |
| Run locally | `claude --plugin-dir .` |
| Plugin eval suite (local only) | `claude plugin eval . --no-publish --scaffold --allow-tools Edit --model claude-sonnet-4-6 --judge-model claude-haiku-4-5 --max-cost-usd 5 -j 4` |

CI (`.github/workflows/test.yml`) runs the tests and the validate on the floor (2.1.304) and the latest Claude Code (the directory profile on latest only), plus a grep that fails on any hex color literal outside `hooks/theme.ts`. CI does not run `tsc`: run all checks locally before pushing.

The eval suite under `evals/` makes real model calls (about $2.50 for a full run with the pinned models) and never runs in CI. It mocks the constellation MCP server from `evals/mocks/constellation/`, so no access key or hosted API is involved; only `EVAL_*` env reaches a run, so the hooks module (gated on `CONSTELLATION_ACCESS_KEY`) is inert and the cases cover skills and the MCP tool only. The mock answers every call with one fixed body, not the real response shapes, so the cases prove that skills fire and call the tool, not that their output layout matches what the server returns. `--scaffold` runs the suite's own fixture scripts (`impact-before-edit` seeds a small project to edit) and `--allow-tools Edit` lets that case edit it. Add `--trust-plugin` on the first run in a directory, `--case <glob>` to run one case, and read the with/without-plugin delta in the table. Results land in `evals/results/` (git-ignored). The behavioural cases (`impact-before-edit`, `symbol-lookup-prefers-code-intel`) depend on model choice and can score below 1.00 on a run.

Validate on the plugin manifest prints every event the module hooks and every `$.*` call. The README Data Handling row must list exactly those `calls:`.

## Layout

| Path | What |
|------|------|
| `.claude-plugin/plugin.json` | Manifest; `userConfig` options: `nudgeLimit`, `augmentGrep`, `impactGate`, `impactThreshold`, `turnSummary`, `showFreshness`, `compactToolRows`, `showAdoption`, `prImpact` |
| `.claude-plugin/marketplace.json` | Marketplace listing (`source: ./`) |
| `.mcp.json` | MCP server keyed `constellation` (`npx @constellationdev/mcp`, stdio) |
| `skills/` | Eight skills: user-only `status`, `diagnose`, `impact`, `deps`, `unused`, `architecture` (invoked as `/constellation:<name>`), plus model-invocable `constellation-troubleshooting` (+ `references/error-codes.md`) and `impact-analysis` |
| `output-styles/code-intelligence.md` | Opt-in "Code Intelligence" output style |
| `hooks/hooks.json` | Empty `"hooks"` block beside `"modules": ["./register.ts"]` |
| `hooks/register.ts` | Module entry: one `registerX(on[, options])` call per handler file |
| `hooks/*.ts` / `*.test.ts` | In-process hooks module and co-located tests (`claude-code/testing`) |
| `evals/` | Local `claude plugin eval` suite: one folder per case (`prompt.md`, `graders/`, optional `case.yaml` and fixture), mocked MCP server in `mocks/constellation/` |
| `types/index.d.ts` | The plugin's contract (`"types"` in `plugin.json`): the `$.state` keys its drawings read (`PluginState`) |

Loading the plugin writes git-ignored `.claude-plugin/types/` (engine `.d.ts`) and a root `tsconfig.json` extending it.

### Hooks module files

| File | Feature |
|------|---------|
| `nudge.ts` | Search reminder |
| `budget.ts` | Per-agent nudge budget (main turn set via `startMainTurn`); the single code_intel observer |
| `classify.ts` | Search classifier (Grep pattern, Glob stem, Bash grep/rg), `ghPrCreate` |
| `describe.ts` | Search tool description guidance; main-loop `turn.start` (main turn id, working-directory change) |
| `augment.ts` | One code_intel line after a symbol search |
| `adoption.ts` | Local code_intel vs text-search counter, spinner suffix |
| `session.ts` | All resets on `session.end` (clear, resume) and `turn.complete` pruning |
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
- **Commands:** user-only skills under `skills/<name>/SKILL.md` (no `name:` key, so the directory keeps `/constellation:<name>`) with `disable-model-invocation: true` and `disallowed-tools: Skill`. `allowed-tools: mcp__plugin_constellation_constellation__code_intel` only, no `model:` override, and every body includes `IMPORTANT: Do NOT invoke any skills or other commands. Directly call the MCP tool specified below.`
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

Live checks to confirm interactively (`claude --plugin-dir .`): all six `/constellation:*` invocations work as before; Claude cannot invoke them itself (`disable-model-invocation: true`); `disallowed-tools: Skill` blocks the Skill tool while a user-invoked skill runs; whether bare `/diagnose`, `/impact`, `/deps`, `/unused` and `/architecture` resolve (bare `/status` stays built in). Headless `claude -p` does not load the plugin from `--plugin-dir` for slash input, and bare `/diagnose` and `/impact` did not resolve there, so these remain unconfirmed interactively.

## Environment

```bash
const auth                    # store CONSTELLATION_ACCESS_KEY
const index --full            # full index of the project
```

Error codes and fixes: `skills/constellation-troubleshooting/references/error-codes.md`.

## Worktrees

Create git worktrees only under this repo's `.claude/worktrees/<branch-slug>` (already gitignored), e.g. `git worktree add .claude/worktrees/feat-x -b feat/x origin/main`. Never create them outside the repo (e.g. sibling `../constellation-<name>-<branch>` folders) or in a `.worktrees/` directory.
