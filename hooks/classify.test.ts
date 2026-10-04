import { describe, expect, test } from 'claude-code/testing';
import { bashSearch, bashSearchPattern, type GhPrCreate, ghPrCreate, globHasSymbolStem, isSymbolLike, symbolOf } from './classify';

describe('symbolOf', () => {
	const rows: ReadonlyArray<readonly [string, string | null]> = [
		['AuthService', 'AuthService'],
		['get_user', 'get_user'],
		['$scope', '$scope'],
		['_private', '_private'],
		['  AuthService  ', 'AuthService'],
		['class UserService', 'UserService'],
		['interface UserShape', 'UserShape'],
		['function parseInput', 'parseInput'],
		['def get_user', 'get_user'],
		['func ServeHTTP', 'ServeHTTP'],
		['type Options', 'Options'],
		['getUser\\(', 'getUser'],
		['getUser\\(\\)', 'getUser'],
		['\\bAuthService\\b', 'AuthService'],
		['\\bAuthService', 'AuthService'],
		['AuthService\\b', 'AuthService'],
		['\\bgetUser\\(', 'getUser'],
		['connection refused', null],
		['"connection refused"', null],
		['class', null],
		['import', null],
		['export', null],
		['Package', 'Package'],
		['Type', 'Type'],
		['Default', 'Default'],
		['class User Service', null],
		['TODO', null],
		['FIXME', null],
		['ERROR', null],
		['MAX_RETRIES', null],
		['[A-Z]+', null],
		['Foo|Bar', null],
		['Foo.*', null],
		['Foo+', null],
		['Foo?', null],
		['a.b.c', null],
		['a/b', null],
		['src/app.ts', null],
		['123abc', null],
		['getUser(', null],
		['', null],
	];
	for (const [pattern, expected] of rows) {
		test(`${JSON.stringify(pattern)} gives ${JSON.stringify(expected)}`, () => {
			expect(symbolOf(pattern)).toBe(expected);
			expect(isSymbolLike(pattern)).toBe(expected !== null);
		});
	}
});

describe('bashSearchPattern', () => {
	const rows: ReadonlyArray<readonly [string, string | null]> = [
		['grep Foo .', 'Foo'],
		['grep -rn Foo src/', 'Foo'],
		['grep -e Foo .', 'Foo'],
		['grep -rn --regexp Foo .', 'Foo'],
		['grep --regexp=Foo .', 'Foo'],
		['grep -A 3 -e Foo .', 'Foo'],
		['egrep Foo .', 'Foo'],
		['rg AuthService src/', 'AuthService'],
		['ag Foo', 'Foo'],
		['ack Foo', 'Foo'],
		['git grep Foo', 'Foo'],
		['git grep -n Foo -- src', 'Foo'],
		['grep "connection refused" .', 'connection refused'],
		["grep -rn 'connection refused' src", 'connection refused'],
		["rg '\\bFoo\\b' src", '\\bFoo\\b'],
		['rg "class UserService"', 'class UserService'],
		["rg 'a|b' src", 'a|b'],
		['grep Foo . | head', 'Foo'],
		['grep Foo . ; ls', 'Foo'],
		['grep Foo . && ls', 'Foo'],
		['grep Foo . || true', 'Foo'],
		['cat log.txt | grep ERROR', null],
		['git log | grep x', null],
		['ls && grep Foo .', null],
		['echo hi; rg Foo', null],
		['git log Foo', null],
		['awk /Foo/ file', null],
		['findstr Foo file', null],
		['ls -la', null],
		['', null],
		['grep', null],
		['grep -rn', null],
		['grep -e', null],
		["grep 'unterminated Foo", 'unterminated Foo'],
		['grep -r AuthService .', 'AuthService'],
		['grep -eAuthService .', 'AuthService'],
		['rg -t ts AuthService src', 'AuthService'],
		['rg --type ts AuthService', 'AuthService'],
		['rg --type=ts AuthService', 'AuthService'],
		['grep -A 3 AuthService src', 'AuthService'],
		['rg -C 2 AuthService', 'AuthService'],
		["rg -g '*.ts' AuthService", 'AuthService'],
		["grep --include '*.ts' -rn AuthService .", 'AuthService'],
		['rg -m 1 AuthService', 'AuthService'],
		['rg -- -dashed src', '-dashed'],
		['rg -t ts', null],
		['cd /repo/core && grep -rn GraphQueryService libs', 'GraphQueryService'],
		['cd /repo/core; rg Foo', 'Foo'],
		['cd /repo/core || rg Foo', null],
		['git -C /repo/core grep Foo', 'Foo'],
		['LC_ALL=C grep -rn Foo .', 'Foo'],
		['FOO=1 BAR=2 rg Foo', 'Foo'],
	];
	for (const [command, expected] of rows) {
		test(`${JSON.stringify(command)} gives ${JSON.stringify(expected)}`, () => {
			expect(bashSearchPattern(command)).toBe(expected);
		});
	}
});

describe('globHasSymbolStem', () => {
	const rows: ReadonlyArray<readonly [string, boolean]> = [
		['**/UserService.ts', true],
		['src/**/UserService*.ts', true],
		['**/authService.ts', true],
		['**/Button/*.tsx', true],
		['UserService', true],
		['**/user-service.ts', false],
		['**/README.md', false],
		['**/*.ts', false],
		['src/**/*.test.ts', false],
		['**/*Service.ts', false],
		['**/*', false],
		['src/lib', false],
		['/Users/me/proj/**/*.ts', false],
		['C:/Users/Me/proj/**/*.spec.ts', false],
		['src/Components/*.tsx', false],
		['/Users/me/proj/**/UserService*', true],
		['src/Components/Button.tsx', true],
		['', false],
	];
	for (const [glob, expected] of rows) {
		test(`${JSON.stringify(glob)} gives ${expected}`, () => {
			expect(globHasSymbolStem(glob)).toBe(expected);
		});
	}
});

describe('bashSearch path', () => {
	const rows: ReadonlyArray<readonly [string, string | undefined]> = [
		['rg Foo', undefined],
		['rg Foo src', 'src'],
		['rg -n SearchSymbolsParams ../constellation-cli/src', '../constellation-cli/src'],
		['grep -rn AuthService /abs/core/src', '/abs/core/src'],
		['rg -e Foo lib test', 'lib'],
		['rg -t ts Foo -- src', 'src'],
		['cd /repo/core && grep -rn Foo libs', '/repo/core/libs'],
		['cd /repo/core && rg Foo', '/repo/core'],
		['cd sub && rg Foo /abs/x', '/abs/x'],
		['git -C /repo/core grep Foo', '/repo/core'],
		['git -C core grep Foo lib', 'core/lib'],
	];
	for (const [command, expected] of rows) {
		test(`${JSON.stringify(command)} searches ${JSON.stringify(expected)}`, () => {
			expect(bashSearch(command)?.path).toBe(expected);
		});
	}
});

describe('ghPrCreate', () => {
	const none: GhPrCreate = { dir: undefined, base: undefined, body: undefined, bodyFile: undefined, head: undefined, repo: undefined };

	const matches: [string, Partial<GhPrCreate>][] = [
		['gh pr create --title t --body "a\nb"', { body: 'a\nb' }],
		['gh pr create -b text', { body: 'text' }],
		['gh pr create --body=text', { body: 'text' }],
		['gh pr create --body-file notes.md', { bodyFile: 'notes.md' }],
		['gh pr create -F notes.md', { bodyFile: 'notes.md' }],
		['gh pr create --body-file=notes.md', { bodyFile: 'notes.md' }],
		['gh pr create --base dev', { base: 'dev' }],
		['gh pr create -B dev', { base: 'dev' }],
		['gh pr create --base=dev', { base: 'dev' }],
		['cd sub && gh pr create --title t', { dir: 'sub' }],
		['FOO=1 gh pr create', {}],
		['git push -u origin HEAD && gh pr create --base dev', { base: 'dev' }],
		['git push; gh pr create -b x', { body: 'x' }],
		['cd x && git push && gh pr create', { dir: 'x' }],
		['gh pr create --body x | cat', { body: 'x' }],
		['gh pr new -b x', { body: 'x' }],
		['git push -u origin HEAD\ngh pr create --base dev', { base: 'dev' }],
		['cd x\ngh pr create', { dir: 'x' }],
		['gh pr create --body "line one\nline two"', { body: 'line one\nline two' }],
		['gh pr create --head feat/y', { head: 'feat/y' }],
		['gh pr create -H feat/y -R owner/repo', { head: 'feat/y', repo: 'owner/repo' }],
		['gh pr create --repo=owner/repo', { repo: 'owner/repo' }],
	];
	for (const [line, expected] of matches) {
		test(`matches ${line}`, () => {
			expect(ghPrCreate(line)).toEqual({ ...none, ...expected });
		});
	}

	const misses = [
		'gh pr view',
		'gh pr list',
		'echo gh pr create',
		'git status',
		'ls | gh pr create',
	];
	for (const line of misses) {
		test(`does not match ${line}`, () => {
			expect(ghPrCreate(line)).toBeNull();
		});
	}
});
