---
paths:
  - "hooks/**"
  - "**/constellation-claude/hooks/**"
---

# Hooks module: constraints and verified engine behavior

Version floor: Claude Code 2.1.304 (the least version with every event, field and `Text` weight the hooks use). Older builds ignore `"modules"` and read the empty `"hooks"` block, so they run no hooks (untested).

## Validate and directory rules

- **One unmatched hook per event.** Validate refuses an event registered twice without a matcher (checked on 2.1.308). Hooks with matchers, even identical ones, are accepted (`turnsummary.ts` and `impact.ts` both hook `tool.call` on the edit tools). Shared unmatched events therefore live in one file: see the ownership table.
- **`$` does not cross imports.** Validate follows `$` only into functions in the same file. Helpers in `lib.ts` (and every non-handler module) take values or closures; the handler spells each call: `projectRoot(await $.session.cwd(), (p) => $.fs.exists(p))`, `codeIntel({ connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) }, code, { cwd })`. This keeps validate's `calls:` list complete.
- **Env names must be literals.** Read the key as `$.env.get('CONSTELLATION_ACCESS_KEY')`; validate lists env names from literals.
- **Permission-event hooks** (`classic.PreToolUse`, `tool.check`) must return `next(e)` itself or an object with a fixed `ask`/`deny`, never something built from what `next` resolved to (Anthropic's directory rule). That is why the search reminder adds context on `tool.call`, and why the impact gate learns core's decision from a `$.tool.check({ tool, input })` query instead of reading `next`.
- **Grep and Glob may not exist.** Native macOS/Linux builds register neither; search runs through Bash. Match with `/^(Grep|Glob|Bash)$/`, compare names via `String(e.tool)`, and cast a test's Grep input to `ToolCallArgs` for tsc.

## Hook ownership

| Event (matcher) | File | Also does |
|-----------------|------|-----------|
| `tool.call` `/code_intel$/` | `budget.ts` | the single code_intel observer: stamps the budget (every origin), and for `next.origin.plugin === 'engine'` only feeds adoption `noteCodeIntelCall`, onboarding `observeCodeIntel`, freshness `observeEnvelope`, impact `noteCodeIntel` |
| `tool.call` `/^(Grep\|Glob\|Bash)$/` | `nudge.ts` | reminder + adoption `noteSearch` |
| `tool.describe` | `describe.ts` | |
| `turn.start` | `describe.ts` | main loop only (a subagent's `turn.start` is skipped): stamps budget's main turn via `startMainTurn` before any `$` call, then, when `$.session.cwd()` differs from the last main-loop turn's, pings/compares freshness for a new project root and re-describes if the gate opens. The first turn only seeds the directory |
| `tool.call` `/^(Grep\|Bash)$/` | `augment.ts` | |
| `session.end` `{reason: clear\|resume}` | `session.ts` | calls every `reset*()` and writes the drawn `$.state` values back with `update`: adoption counts and pane to their initial, the band through `resetBand` (keeps not set up and no project); the freshness line stays. `/clear` ends with `clear`, `/resume` and `/branch` with `resume`; the other reasons (`logout`, `prompt_input_exit`, `other`) leave state alone |
| `turn.complete` | `session.ts` | `forget*` for an ended subagent run; main-loop turn summary line |
| `session.start` | `command.ts` | registers `/constellation`, onboarding key read-back + `$.env.set`, clears the stored freshness line (a load starts the indicator over), freshness ping + 5 min git timer, and, when `$.ui.panes()` lists the pane (a reload keeps it up), starts again what it still waits for |
| `command.run`, `ui.render` Pane, `ui.close` | `command.ts` | `ui.close` writes the initial pane on the person's close; an unload drops the pane before hooks hear of it and runs none of its opener's |
| `tool.check` edit tools | `impact.ts` (`ask` only; `dialog`/`native` alias it) | real calls with an `approver` only; reads core's decision from a `$.tool.check` query; a fixed `ask` with the impact as the reason, once per file |
| `tool.call` edit tools | `impact.ts` (`ask` only) | remembers a file once an edit it asked about ran without an error (a rejected prompt or failed edit asks again) |
| `tool.call` edit tools | `impact.ts` (require-analysis only), `turnsummary.ts` | |
| `tool.call` `'Bash'` | `primpact.ts` | registered unless `prImpact` is `off` |
| `tool.call` `/^Bash$/` | `freshness.ts` | rechecks after git commit/pull/checkout/merge/rebase |
| `ui.render` AbovePrompt | `onboarding.ts` | draws `freshnessBand` when there is no onboarding state and `showFreshness` is on |
| `ui.render` ToolUse/ToolResult, `config.set` theme/verbose | `toolrows.ts` | |
| `ui.render` Spinner | `adoption.ts` | only when `showAdoption === true` |

Every boolean option except `showAdoption` treats unset as on; an unknown string option falls back to its default. An off option registers no hook.

## Design invariants

- **What a drawing reads is `$.state`; the rest is module variables.** The contract `types/index.d.ts` (named by `"types"` in `plugin.json`, self-contained: validate refuses any import in it) declares four keys, each `Shaped<T>`: `adoption` (session counts: the spinner and the Stats tab), `freshness` (the line, null when none), `band` (the onboarding band) and `pane` (`/constellation`: the tab, each tab's answer, what is selected). A drawing reads them with `read($, atom)`, which subscribes it, so a write redraws it with no `$.ui.invalidate`; only handlers write, with `update($, atom, fn)`, and `fn` only computes (it runs again on a version miss). Validate reads only an atom built in the same file, so the owner exports the shape tag and initial (`ADOPTION_SHAPE`/`NO_COUNTS`, `FRESHNESS_SHAPE`, `BAND_SHAPE`/`NO_BAND`, `PANE_SHAPE`/`NO_PANE`) and each file that reads or writes a key builds its own atom from them. Bump a shape tag when the value's meaning changes, so a reload declines what older code wrote. A reload keeps these values, except the freshness line, which the load's `session.start` clears because the facts behind it start over; module variables start over, cleared by each `registerX`: budgets, the risk cache, impact assessed/remembered, augment lines, the freshness facts (index, checkout, root), the reads of `$.config` and `$.store` cached for drawing, and the work in flight (pending queries, generations, a CLI run, timers), which a reload ends. The `ui.render` invalidates left redraw module values: toolrows' `config.set` (the cached theme and verbose read), the band's Dismiss (the dismissal read from the store), the Unused tab's load-more read in flight, the pane's queries `session.start` starts again, and a pane answer the state refused (its pending flag cleared). The pane's launched reads never reject: a refused write is caught and its in-flight flag cleared. Per-agent state is keyed `agentKey(e)` (`'main'` or `e.agentId`) and dropped when the subagent's run ends. `$.store` is the only cross-session store; adoption counts stay on the machine and its values for them hold numbers only (no paths, patterns or code).
- **Prompt cache.** `REMINDER_TEXT` and `GUIDANCE` stay constant (no counts, paths). The engine asks `tool.describe` once per tool per session; once guidance is in it stays, because removing it rewrites the tools block and the whole cache.
- **Added context.** No hook adds session or subagent start text; the code_intel preference lives in `GUIDANCE`. `tool.call` adds `{ ...r, context: [...] }` (read by the model after the result; keep `r.result` and `r.ref`).
- **Working-directory changes** are noticed at the next main-loop `turn.start`, not when they happen: a Bash `cd` mid-turn moves the freshness indicator and opens the description gate one turn later.
- **Resets run at `session.end`** of the ending session. A freshness ping already in flight at `/clear` can still land afterwards (the earlier session-start reset had the same race); it is tolerated, not guarded.
- **Own lookups vs the agent's.** A plugin `$.mcp.call` of code_intel raises `tool.call` with `next.origin.plugin` set to the plugin name (the model's carry `engine`). Plugin lookups stamp the turn (quieting that turn's nudges) but never count as adoption or impact evidence.
- **Code sent to code_intel is real code.** `lookupSymbol`, `probe`, `orphanQuery`, `searchQuery` are tested functions sent via `fn.toString()`; user strings go in through `JSON.stringify`. Return only the fields the caller reads: a result over Claude Code's MCP output limit reaches `$.mcp.call` as a non-JSON `Error: result (N characters) exceeds maximum allowed tokens...` text with `isError` false (`INVALID_RESPONSE`).
- **code_intel limits.** 50 `api.*` calls per run, so `blast.ts` reads `getDependents({ limit: 100, includeSymbols })` once per file, at most 50 files. `blast.ts` and `risk.ts` send only project-relative paths, never absolute ones. Use `getDependents`, not `searchSymbols` with `filterByFile` (substring match; core rejects patterns over 200 chars). `searchSymbols` is substring in name order: read a full page and rank exact matches client side (`rankExact`). Core refuses `getCallGraph` for kinds other than `function`, `method`, `generator`, and one refused read fails the whole `Promise.all`.
- **Dependents undercount** imports through tsconfig path aliases and `export *` barrels, and come from the last indexed commit, so every count shows the 7-char `asOfCommit`. Impact thresholds (5 medium, 20 high, 50 critical) are untuned.
- **Git from hooks** runs via `$.process.run` with `GIT`, `GIT_ENV`, `GIT_TIMEOUT_MS` from `lib.ts`, fails open, and `primpact.ts` disables fsmonitor, hooks, external diff and lazy fetch because it runs before the Bash call is approved. `asOfCommit` reaches argv only after a hex check.
- **Onboarding CLI spawn.** `cliPath` tries plain `/bin/sh -c` then login `/bin/sh -lc`; `constellation auth` is spawned directly with `CONSTELLATION_ACCESS_KEY: ''` (a login shell would re-export the stored key). A CLI path inside the repo counts as not found. Windows (no `/bin/sh`): no buttons, key read via `C:\Windows\System32\reg.exe`. Verify end state (readable key, `ping` `success: true`), never the CLI exit code. The automatic ping runs only when `constellation.json` has no `apiUrl` or the default `https://api.constellationdev.io`, since the server sends the key to that URL.
- **Pane.** One `ui.render` hook draws all six tabs from the `pane` key; controls use their own `onPress`/`onSelect`/`onSubmit` callbacks, and the plugin registers no `ui.press`/`ui.input`/`ui.select` hook. A control writes the pane through `act` (`update`), which redraws it. Queries start in the handler that changed the pane (`command.run`, a control), never in the drawing, since work a drawing starts cannot write state; a handler starts its query before its own write lands, so that redraw already shows the tab pending, and the answer is written after it (`written`). `QueryTab` excludes `stats` so the compiler refuses a query for it.
- **Text weight.** Bold text is `weight: 'semibold'` (a `Tone` carries `weight`, not `bold`). The one exception is the `hover` of a clickable row in `command.ts`, where `bold: true` stays because `TextHoverProps` has no `weight`; a prompt decoration likewise has only `bold`.
- **Theme.** Colors only in `theme.ts` (CI-enforced). Follow Claude Code's theme via `scheme(theme)`/`forTheme`/`paint`; no color option. No background colors, never color alone (every badge has a word and glyph), color marks status and risk only. Buttons: cancel left, affirmative right, `justifyContent: 'flex-end'`, `columnGap: 2`. On Desktop use `boxTable`/`factTable`, never `Markdown` tables (cells can't be colored, graph text would parse as links).

## Verified Claude Code behavior

- `$.mcp.connect('constellation')` before every call and pass the name it returns to `$.mcp.call`: the name differs by load (`plugin:constellation:constellation`, or the project server's name under `--plugin-dir` in this repo). Never hard-code it. A refusal returns a reason (reported as `MCP_UNAVAILABLE`), it does not throw.
- `$.command.register({ name: 'constellation' })` resolves bare `constellation`, coexisting with the `/constellation:*` skills. Names allow letters, digits, `_`, `-`. Register last inside try/catch, no retry: a throw skips the rest of `session.start`.
- `$.command.run` is refused inside `command.run`; schedule `reload-plugins` with `$.clock.after(0, ...)`. A reload unloads the module, so chain nothing after it.
- `$.fs.ancestors` accepts only `.md` names; `projectRoot`/`gitRoot` walk up with `$.fs.exists`.
- `tool.describe` has no `agentId`; the rewritten description reaches subagents. `tool.check` carries `agentId` since 2.1.290 but still no permission mode; on a real call it carries `approver`, who answers its asks.
- `$.ui.toast` is plain text: no ANSI (escape drawn as `�`), titled with the plugin `name`, fullscreen draws up to three at a time, and the classic renderer replaces the older toast with the newer one.
- The `/theme` picker raises neither `config.set` nor `classic.ConfigChange` (the `/config` menu does), so cached theme reads also expire after one second.
- `theme` row of `$.config.list()` options: `auto`, `dark`, `light`, `light-daltonized`, `dark-daltonized`, `light-ansi`, `dark-ansi`; `auto` reads as dark.
- A real Edit raises `tool.call` with `tool.check` inside it, both with the same `tool_use_id`; a `$.tool.check` query has none.
- `tool.check`'s `approver` is known before any hook runs: `person` (a dialog or card), `host` (a host's permission callback), absent where nobody can be asked. A hook `ask` with no one to answer becomes a refusal, so the impact gate leaves such a call to core. Only core's own `ask` goes to the auto-mode classifier; a hook's `ask` goes to the approver, in auto mode too. `bypassPermissions` still honors a hook `ask`.
- `tool.check` deny reaches the model as `Permission to use Edit denied by plugin <name>: <reason>`; `tool.call` `{ deny }` reaches it verbatim in `<tool_use_error>`.
- `turn.complete` `text` shows as a system informational line and never enters the model's transcript.
- `session.end` (checked on 2.1.311): `/clear` raises it with `clear` before the next prompt, under the ending session's id; the next `turn.start` runs under a new one. `/branch` and `/resume` raise it with `resume` for the session being left. No `session.start` follows any of them.
- `$.state` (checked in the test kit on 2.1.311 and 2.1.304): a `ui.render` hook's `$` refuses `state.set` while its drawing is dispatched, even after awaits (`denied: it was made while ui.render is being dispatched`); a callback the drawing handed out (`onPress`) writes once that drawing has ended. A write that lands while a drawing that read the value is still being dispatched does not draw it again, so the pane reads its values together first thing. `session.end` with `clear` leaves `$.state` as it was, so `session.ts` writes the drawn values back itself.
- Not live-verified: `$.prompt.fill`, `$.ui.copy`, spinner redraw, the impact gate's hook `ask` in each permission mode and how a rejected prompt reaches `tool.call` (assumed `isError`), whether the live engine itself starts `$.state` over at `/clear` or `/resume` (the writes in `session.ts` hold either way).

## Tests (`claude-code/testing`)

- The test `$` has no `$.state`: watch a loaded plugin's writes with `on('state.set', (_, e, next) => next(e))` or through what it draws. A stand-in `$` gets a `state` fake over a `Map` with versions (`get` answers `{ value, version }`, `set` misses on a stale `ifVersion`) so `read` and `update` work; a reload is a second `registerX` over the same fake, which starts the module over and keeps the values.
- A drawing misses a write that lands while it is dispatched, so `mountPane` in `command.test.ts` lets the work `command.run` started settle before the first draw.

- A loaded plugin is a separate module instance from what the test file imports: assert module state through registered handlers via a stand-in `on`, plus one loaded-plugin test with `options` for wiring.
- The test `$` has engine events and `mock.env`, `mock.clock`, `mock.store`, but no `$.mcp`, `$.fs` and no file system. `mock.env(on, { NAME: 'value' })` answers `$.env.get`. Answer the others with `on('mcp.call', ...)`, `on('fs.exists', ...)`, `on('session.cwd', ...)`; pass plain fakes to helpers.
- Answer the tool with one `on('tool.call', ...)` (twice fails the load); a Bash call also needs `on('classic.PreToolUse', () => ({}))` beneath. `mock.clock(on)` holds `$.clock.sleep` until `clock.advance(ms)`; await `settled()` instead of sleeping on background writes.
- In the test kit a loaded plugin's own `$.mcp.call` does not pass through its own `tool.call` hooks (it does live): raise those through a stand-in `on` with `next.origin` set.
- A stand-in harness that raises `turn.start` and reads the main turn (`usedCodeIntelThisTurn`) registers `registerDescribe` beside `registerBudget`, since describe owns that hook. Its `$` answers `session.cwd`.
- Reminder and augment share `context`, so `augment.test.ts` runs with `nudgeLimit: 0` except the ordering test.
