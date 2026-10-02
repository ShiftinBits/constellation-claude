import { describe, expect, test } from 'claude-code/testing';
import { bashSearchPattern, globHasSymbolStem, isSymbolLike, symbolOf } from './classify';

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
		['class', 'class'],
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
		['', false],
	];
	for (const [glob, expected] of rows) {
		test(`${JSON.stringify(glob)} gives ${expected}`, () => {
			expect(globHasSymbolStem(glob)).toBe(expected);
		});
	}
});
