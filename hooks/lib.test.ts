import { describe, expect, test } from 'claude-code/testing';
import { codeIntel, isConfigured, projectRoot, type McpPort } from './lib';

type Connection = Awaited<ReturnType<McpPort['connect']>>;

type ToolResult = Awaited<ReturnType<McpPort['call']>>;

type Call = { server: string; tool: string; args: Record<string, unknown> | undefined };

function text(body: string): ToolResult {
	return { content: [{ type: 'text', text: body }], isError: false };
}

const CONNECTED: Connection = { isConnected: true, server: 'plugin:constellation:constellation' };

/** A host whose MCP connection is `connection` and whose tool calls answer through `answer`. */
function mcpHost(
	connection: Connection,
	answer: (call: Call) => ToolResult,
) {
	const connects: string[] = [];
	const calls: Call[] = [];
	const host: McpPort = {
		connect: async (server) => {
			connects.push(server);
			return connection;
		},
		call: async (server, tool, args) => {
			const call = { server, tool, args };
			calls.push(call);
			return answer(call);
		},
	};
	return { host, connects, calls };
}

describe('codeIntel', () => {
	test('reports MCP_UNAVAILABLE with the connect reason when the server is not connected', async () => {
		const { host, calls } = mcpHost({ isConnected: false, reason: 'auth', message: 'needs sign-in' }, () => text('{}'));
		const envelope = await codeIntel(host, 'return 1', { cwd: '/p' });
		expect(envelope.success).toBe(false);
		expect(envelope.error?.code).toBe('MCP_UNAVAILABLE');
		expect(envelope.error?.message).toBe('auth: needs sign-in');
		expect(calls.length).toBe(0);
	});

	test('parses a success envelope and calls code_intel with code and cwd', async () => {
		const body = JSON.stringify({
			success: true,
			result: { pong: true },
			asOfCommit: 'abc123',
			lastIndexedAt: '2026-10-02T15:10:19Z',
			time: 500,
			logs: ['ignored'],
		});
		const { host, connects, calls } = mcpHost(CONNECTED, () => text(body));
		const envelope = await codeIntel(host, 'return await api.ping()', { cwd: '/p' });
		expect(envelope).toEqual({
			success: true,
			result: { pong: true },
			asOfCommit: 'abc123',
			lastIndexedAt: '2026-10-02T15:10:19Z',
			time: 500,
		});
		expect(connects).toEqual(['constellation']);
		expect(calls).toEqual([
			{
				server: 'plugin:constellation:constellation',
				tool: 'code_intel',
				args: { code: 'return await api.ping()', cwd: '/p' },
			},
		]);
	});

	test('connects on every call and calls the name the server runs under now', async () => {
		let server = 'plugin:constellation:constellation';
		const calls: string[] = [];
		const host: McpPort = {
			connect: async () => ({ isConnected: true, server }),
			call: async (name) => {
				calls.push(name);
				return text('{"success":true}');
			},
		};
		await codeIntel(host, 'a', { cwd: '/p' });
		server = 'constellation';
		await codeIntel(host, 'b', { cwd: '/p' });
		expect(calls).toEqual(['plugin:constellation:constellation', 'constellation']);
	});

	test('an error result that is not an envelope becomes MCP_TOOL_ERROR with its text', async () => {
		const { host } = mcpHost(CONNECTED, () => ({ content: [{ type: 'text', text: 'server restarting' }], isError: true }));
		const envelope = await codeIntel(host, 'x', { cwd: '/p' });
		expect(envelope).toEqual({ success: false, error: { code: 'MCP_TOOL_ERROR', message: 'server restarting' } });
	});

	test("an error result carrying code_intel's envelope keeps its code and is never a success", async () => {
		const body = JSON.stringify({ success: true, error: { code: 'AUTH_ERROR', message: 'bad key' } });
		const { host } = mcpHost(CONNECTED, () => ({ content: [{ type: 'text', text: body }], isError: true }));
		const envelope = await codeIntel(host, 'x', { cwd: '/p' });
		expect(envelope.success).toBe(false);
		expect(envelope.error?.code).toBe('AUTH_ERROR');
	});

	test('parses an error envelope with its code, message and guidance', async () => {
		const body = JSON.stringify({
			success: false,
			error: { code: 'PROJECT_NOT_INDEXED', message: 'not indexed', guidance: ['run index', 7] },
		});
		const { host } = mcpHost(CONNECTED, () => text(body));
		const envelope = await codeIntel(host, 'x', { cwd: '/p' });
		expect(envelope).toEqual({
			success: false,
			error: { code: 'PROJECT_NOT_INDEXED', message: 'not indexed', guidance: ['run index'] },
		});
	});

	test('returns INVALID_RESPONSE for text that is not JSON, not an envelope, or missing', async () => {
		const bodies = ['not json', '[1]', '{"result":1}'];
		for (const body of bodies) {
			const { host } = mcpHost(CONNECTED, () => text(body));
			const envelope = await codeIntel(host, 'x', { cwd: '/p' });
			expect(envelope.success).toBe(false);
			expect(envelope.error?.code).toBe('INVALID_RESPONSE');
		}
		const { host } = mcpHost(CONNECTED, () => ({ content: [{ type: 'image' }], isError: false }));
		const envelope = await codeIntel(host, 'x', { cwd: '/p' });
		expect(envelope.error?.code).toBe('INVALID_RESPONSE');
	});

	test('never throws: a failing call becomes MCP_CALL_FAILED and the next call recovers', async () => {
		const connects: string[] = [];
		let fail = true;
		const host: McpPort = {
			connect: async (server) => {
				connects.push(server);
				return CONNECTED;
			},
			call: async () => {
				if (fail) throw new Error('transport closed');
				return text('{"success":true}');
			},
		};
		const failed = await codeIntel(host, 'x', { cwd: '/p' });
		expect(failed.success).toBe(false);
		expect(failed.error?.code).toBe('MCP_CALL_FAILED');
		expect(failed.error?.message).toBe('transport closed');
		fail = false;
		const recovered = await codeIntel(host, 'x', { cwd: '/p' });
		expect(recovered.success).toBe(true);
		expect(connects.length).toBe(2);
	});
});

describe('isConfigured', () => {
	test('is false with no key', () => {
		expect(isConfigured(undefined)).toBe(false);
	});

	test('is false with an empty key', () => {
		expect(isConfigured('')).toBe(false);
	});

	test('is false with a key that does not start with ak:', () => {
		expect(isConfigured('sk:abc')).toBe(false);
	});

	test('is true with an ak: key', () => {
		expect(isConfigured('ak:x')).toBe(true);
	});
});

describe('projectRoot', () => {
	const existsIn = (files: readonly string[]) => async (path: string) => files.includes(path);

	test('finds constellation.json in an ancestor of a file', async () => {
		const exists = existsIn(['/repo/constellation.json']);
		expect(await projectRoot('/work', exists, '/repo/src/deep/file.ts')).toBe('/repo');
	});

	test('prefers the nearest ancestor', async () => {
		const exists = existsIn(['/repo/constellation.json', '/repo/pkg/constellation.json']);
		expect(await projectRoot('/work', exists, '/repo/pkg/src/a.ts')).toBe('/repo/pkg');
	});

	test('treats a directory as its own candidate', async () => {
		const exists = existsIn(['/repo/constellation.json']);
		expect(await projectRoot('/work', exists, '/repo')).toBe('/repo');
	});

	test('defaults to the working directory', async () => {
		const exists = existsIn(['/repo/constellation.json']);
		expect(await projectRoot('/repo/src', exists)).toBe('/repo');
	});

	test('resolves a relative path against the working directory', async () => {
		const exists = existsIn(['/repo/constellation.json']);
		expect(await projectRoot('/repo/src', exists, '../lib/./x.ts')).toBe('/repo');
	});

	test('finds a project at the filesystem root', async () => {
		const exists = existsIn(['/constellation.json']);
		expect(await projectRoot('/work', exists, '/repo/a.ts')).toBe('/');
	});

	test('returns null when no ancestor has one', async () => {
		const exists = existsIn(['/other/constellation.json']);
		expect(await projectRoot('/work', exists, '/repo/src/file.ts')).toBeNull();
	});
});
