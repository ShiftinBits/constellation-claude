'use strict';

if (!process.env.CONSTELLATION_ACCESS_KEY?.startsWith('ak:')) process.exit(0);

const readline = require('readline');

const TRIGGER_TOOLS = [
	'grep',
	'rg',
	'glob',
	'awk',
	'findstr',
];

const REMINDER = 'Use the code_intel tool before other tools for searching or navigating the codebase. Other search tools (e.g. grep, glob, awk, rg) should be used for literal text search or as a fallback.';

async function main() {
	let input = '';

	const rl = readline.createInterface({
		input: process.stdin,
		terminal: false,
	});

	for await (const line of rl) {
		input += line;
	}

	let inputData;
	try {
		inputData = JSON.parse(input);
	} catch (e) {
		return;
	}

	const toolInput = inputData.tool_input || {};
	const command = toolInput.command || '';

	if (!command) return;

	for (const tool of TRIGGER_TOOLS) {
		if (new RegExp(`^${tool}\\b(?!.*\\|)`).test(command)) {
			process.stdout.write(JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					additionalContext: REMINDER,
				},
			}));
			return;
		}
	}
}

main();
