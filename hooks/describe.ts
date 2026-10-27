import type { EngineInterface, On } from 'claude-code';
import { startMainTurn } from './budget';
import { freshnessLine, observeEnvelope, recheck, track } from './freshness';
import type { Run } from './freshness';
import { canDraw, isConfigured, projectRoot } from './lib';
import type { McpPort } from './lib';
import { pingProject } from './onboarding';

/**
 * Appended to the description of every search tool the model sees. Constant, so
 * the cached description keeps the prompt cache valid.
 */
export const GUIDANCE =
	'\n\nThe code_intel tool is the preferred tool for searching and navigating the codebase. For symbol definitions, references, dependents, call graphs or impact, use the code_intel tool. Grep, Glob and grep or rg in the shell are for literal text such as error messages, config values, log strings and comments.';

/**
 * The last gate result a description was built under; undefined until one is.
 * Once the guidance is in, it stays: it is harmless outside a project, and
 * taking it out again would change the tools block and rewrite the prompt cache
 * every time Claude `cd`s out of and back into an indexed project.
 */
let lastGate: boolean | undefined;

/**
 * The working directory the main loop's last turn started in; undefined until
 * the first. A change between two turns (a `cd` included) is noticed here, at
 * the start of the next main-loop turn.
 */
let lastCwd: string | undefined;

/** True when the access key starts with `ak:` and `cwd` sits inside an indexed project. */
async function gateOpen($: EngineInterface, cwd: string): Promise<boolean> {
	if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return false;
	return (await projectRoot(cwd, (p) => $.fs.exists(p))) !== null;
}

export function registerDescribe(on: On): void {
	lastCwd = undefined;

	on('tool.describe', { tool: /^(Grep|Glob|Bash)$/ }, async ($, e, next) => {
		const r = await next(e);
		const open = lastGate === true || (await gateOpen($, await $.session.cwd()));
		lastGate = open;
		if (!open) return r;
		return { ...r, description: r.description + GUIDANCE };
	});

	on('turn.start', async ($, e, next) => {
		if (e.agentId !== undefined) return next(e);
		startMainTurn(e.turnId);
		const r = await next(e);
		try {
			const cwd = await $.session.cwd();
			if (lastCwd === undefined) {
				// The session's first turn: the freshness indicator already pinged at session start.
				lastCwd = cwd;
				if (lastGate === false && (await gateOpen($, cwd))) {
					lastGate = true;
					$.ui.invalidate('tool.describe');
				}
				return r;
			}
			if (cwd === lastCwd) return r;
			lastCwd = cwd;
			// The freshness indicator follows the project: a new one is pinged for what is indexed, the same one compared again.
			try {
				const root = isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY')) ? await projectRoot(cwd, (p) => $.fs.exists(p)) : null;
				if (root !== null) {
					const run: Run = (argv, init) => $.process.run(argv, init);
					const invalidate = () => $.ui.invalidate('ui.render');
					const log = async (text: string) => {
						if (!canDraw(await $.session.surfaces())) $.ui.log(text);
					};
					const showing = freshnessLine(Date.now()) !== undefined;
					if (track(root)) {
						// The last project's line goes.
						if (showing) invalidate();
						const mcp: McpPort = { connect: (s) => $.mcp.connect(s), call: (s, t, a) => $.mcp.call(s, t, a) };
						void pingProject(root, { read: (p) => $.fs.read(p), mcp })
							.then((envelope) => (envelope === undefined ? undefined : observeEnvelope(envelope, root, run, invalidate, log)))
							.then(() => recheck(run, invalidate, log))
							.catch(() => undefined);
					} else {
						void recheck(run, invalidate, log).catch(() => undefined);
					}
				}
			} catch {
				// The indicator stays as it was; the gate below still runs.
			}
			if (lastGate !== false) return r;
			if (await gateOpen($, cwd)) {
				lastGate = true;
				$.ui.invalidate('tool.describe');
			}
		} catch {
			// Fails open: the turn goes on untouched, and a later turn reads the working directory again.
		}
		return r;
	});
}
