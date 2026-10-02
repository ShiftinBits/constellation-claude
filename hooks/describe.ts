import type { EngineInterface, On } from 'claude-code';
import { isConfigured, projectRoot } from './lib';

/**
 * Appended to the description of every search tool the model sees. Constant, so
 * the cached description keeps the prompt cache valid.
 */
export const GUIDANCE =
	'\n\nFor symbol definitions, references, dependents, call graphs or impact, use the code_intel tool. Grep, Glob and grep or rg in the shell are for literal text such as error messages, config values, log strings and comments.';

/** The last gate result a description was built under; undefined until one is. */
let lastGate: boolean | undefined;

/** True when the access key starts with `ak:` and `cwd` sits inside an indexed project. */
async function gateOpen($: EngineInterface, cwd: string): Promise<boolean> {
	if (!isConfigured(await $.env.get('CONSTELLATION_ACCESS_KEY'))) return false;
	return (await projectRoot(cwd, (p) => $.fs.exists(p))) !== null;
}

export function registerDescribe(on: On): void {
	on('tool.describe', { tool: /^(Grep|Glob|Bash)$/ }, async ($, e, next) => {
		const r = await next(e);
		const open = await gateOpen($, await $.session.cwd());
		lastGate = open;
		if (!open) return r;
		return { ...r, description: r.description + GUIDANCE };
	});

	on('classic.CwdChanged', async ($, e, next) => {
		const r = await next(e);
		if (lastGate === undefined) return r;
		const open = await gateOpen($, e.new_cwd);
		if (open !== lastGate) {
			lastGate = open;
			$.ui.invalidate('tool.describe');
		}
		return r;
	});
}
