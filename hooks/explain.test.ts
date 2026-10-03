import { describe, expect, test } from 'claude-code/testing';
import { explain, explainLines } from './explain';

const ROOT = '/home/runner/work/app/app';

/** The CWD_NOT_INDEXED error constellation-mcp sends when no project lies under the git root. */
const NO_PROJECT = {
	code: 'CWD_NOT_INDEXED',
	message: `[CWD_NOT_INDEXED] No constellation.json found at git root '${ROOT}'`,
	guidance: [
		`No constellation.json was found at git root '${ROOT}', and no candidate project roots were discovered under it.`,
		`Initialize this project by running \`constellation init\` inside '${ROOT}' (or a subdirectory that IS the project root), then \`constellation auth\` and \`constellation index\`.`,
		'For more information, visit: https://docs.constellationdev.io',
	],
};

describe('explain', () => {
	test('a folder with no project reads as a headline, the commands to run, the docs and the code', () => {
		expect(explain(NO_PROJECT)).toEqual({
			title: "This folder isn't a Constellation project",
			detail: 'No constellation.json at the root of this repository.',
			notes: [],
			steps: ['constellation init', 'constellation auth', 'constellation index'],
			docs: 'https://docs.constellationdev.io',
			code: 'CWD_NOT_INDEXED',
			projects: [],
		});
	});

	test('its text reply lays that out under the headline, with no repeated path', () => {
		const lines = explainLines(explain(NO_PROJECT));
		expect(lines).toEqual([
			"✗ This folder isn't a Constellation project",
			'  No constellation.json at the root of this repository.',
			'',
			'  Next steps',
			'  1. constellation init',
			'  2. constellation auth',
			'  3. constellation index',
			'',
			'  Docs   https://docs.constellationdev.io',
			'  Code   CWD_NOT_INDEXED',
		]);
		expect(lines.join('\n')).not.toContain(ROOT);
	});

	test('a rejected key keeps its notes and pulls the command out of "Run:"', () => {
		const ex = explain({
			code: 'AUTH_ERROR',
			message: 'Authentication failed - invalid or missing access key',
			guidance: ['CONSTELLATION_ACCESS_KEY env var verification: set, starts with ak:', 'Run: constellation auth', 'Check that your access key has not expired'],
		});
		expect(ex.title).toBe("Your access key wasn't accepted");
		expect(ex.detail).toBe('Authentication failed - invalid or missing access key');
		expect(ex.steps).toEqual(['constellation auth']);
		expect(ex.notes).toEqual(['CONSTELLATION_ACCESS_KEY env var verification: set, starts with ak:', 'Check that your access key has not expired']);
	});

	test('commands chained with && become separate steps, and guidance written for an agent is dropped', () => {
		const ex = explain({
			code: 'NOT_CONFIGURED',
			message: 'Constellation is not configured for this project',
			guidance: [
				'Provide the required `cwd` parameter with the absolute path to the project directory (e.g., cwd: "/path/to/project")',
				'Verify the project has a constellation.json file at the git root',
				'If no constellation.json exists, run: constellation init && constellation auth && constellation index',
			],
		});
		expect(ex.steps).toEqual(['constellation init', 'constellation auth', 'constellation index']);
		expect(ex.notes).toEqual(['Verify the project has a constellation.json file at the git root']);
	});

	test('above several projects the text reply lists them and none of the agent guidance', () => {
		const lines = explainLines(
			explain({
				code: 'CWD_NOT_INDEXED',
				message: "[CWD_NOT_INDEXED] No constellation.json found at git root '/w' (2 candidate project roots discovered)",
				guidance: [
					"No constellation.json was found at git root '/w'.",
					'Discovered 2 candidate project roots: /w/core, /w/web',
					'Re-invoke `code_intel` with `cwd` set to one of these project roots.',
				],
				candidates: ['/w/core', '/w/web'],
			}),
		);
		expect(lines).toEqual([
			"✗ This folder isn't a Constellation project",
			'  No constellation.json at the root of this repository.',
			'',
			'  Run /constellation from one of these projects:',
			'  core  /w/core',
			'  web   /w/web',
			'',
			'  Code   CWD_NOT_INDEXED',
		]);
	});

	test('an unknown code leads with the server message, and the docs field wins over a guidance link', () => {
		const ex = explain({ code: 'SOMETHING_NEW', message: '[SOMETHING_NEW] Something new happened', docs: 'https://docs.example/a', guidance: ['See https://docs.example/b'] });
		expect(ex.title).toBe('Something new happened');
		expect(ex.detail).toBeUndefined();
		expect(ex.docs).toBe('https://docs.example/a');
	});
});
