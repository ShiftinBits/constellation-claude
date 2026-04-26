'use strict';

module.exports = function (hookName) {
	const outputs = {
		SessionStart: {
			hookSpecificOutput: {
				hookEventName: 'SessionStart',
				additionalContext: `You have Constellation access. \`code_intel\` is your PRIMARY tool for understanding this codebase—not an alternative, not a fallback, THE DEFAULT.

Mental model:
- "Where is X defined?" → code_intel
- "What uses X?" → code_intel
- "What would break?" → code_intel
- "Find the string 'ERROR_CODE_123'" → Grep

Grep is for literal text. Everything else starts with code_intel.`,
			},
		},
		SubagentStart: {
			hookSpecificOutput: {
				hookEventName: 'SubagentStart',
				additionalContext: `You have access to Constellation's code_intel MCP tool (mcp__plugin_constellation_constellation__code_intel). For structural code queries—symbol definitions, callers/callees, dependencies, dependents, impact analysis, architecture overview—use code_intel instead of Grep/Glob. Use Grep/Glob for literal text search. If you are searching for a symbol, caller, dependency, or any structural context or relationships, use \`code_intel\` instead — it resolves cross-file relationships and details that text search cannot.`,
			},
		},
		PreToolUse: {
			hookSpecificOutput: {
				hookEventName: 'PreToolUse',
				additionalContext: `For structural code queries; definitions, callers/callees, dependencies, dependents, impact analysis, architecture overview, use \`code_intel\` instead of Grep/Glob. Use Grep/Glob for literal text search. If you are searching for a symbol, caller, dependency, or any structural relationship, use \`code_intel\` instead — it resolves cross-file relationships and details that text search cannot.`,
			},
		},
		PreCompact: {
			systemMessage: `Preserve: (1) The instruction that code_intel is the PRIMARY tool for code searching, navigation, and understanding. Tools like grep/glob are only for literal text. (2) Any architectural insights, dependency relationships, or impact analysis results discovered via Constellation.`,
		},
	};

	const output = outputs[hookName];
	if (!output) return;
	process.stdout.write(JSON.stringify(output));
};
