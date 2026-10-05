import type { EngineInterface, On } from 'claude-code';
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
	'\n\nFor symbol definitions, references, dependents, call graphs or impact, use the code_intel tool. Grep, Glob and grep or rg in the shell are for literal text such as error messages, config values, log strings and comments.';

/**
 * The last gate result a description was built under; undefined until one is.
 * Once the guidance is in, it stays: it is harmless outside a project, and
 * taking it out again would change the tools block and rewrite the prompt cache
 * every time Claude `cd`s out of and back into an indexed project.
 */
let lastGate: boolean | undefined;

/** True when the access key starts with `ak:` and `cwd` sits inside an indexed project. */
async function gateOpen($: EngineInterface, cwd: string): Promise<boolean> {
	if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return false;
	return (await projectRoot(cwd, (p) => $.fs.exists(p))) !== null;
}

export function registerDescribe(on: On): void {
	on('tool.describe', { tool: /^(Grep|Glob|Bash)$/ }, async ($, e, next) => {
		const r = await next(e);
		const open = lastGate === true || (await gateOpen($, await $.session.cwd()));
		lastGate = open;
		if (!open) return r;
		return { ...r, description: r.description + GUIDANCE };
	});

	on('classic.CwdChanged', async ($, e, next) => {
		const r = await next(e);
		// The freshness indicator follows the project: a new one is pinged for what is indexed, the same one compared again.
		try {
			const root = isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY')) ? await projectRoot(e.new_cwd, (p) => $.fs.exists(p)) : null;
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
		if (await gateOpen($, e.new_cwd)) {
			lastGate = true;
			$.ui.invalidate('tool.describe');
		}
		return r;
	});
}
