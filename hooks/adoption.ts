import { isRecord, num } from './lib';

/** How often code_intel was called, how long those calls took, and how many text searches ran beside them. */
export type Counts = {
	/** code_intel calls the agent made. */
	codeIntel: number;
	/** The time those calls reported, summed, in milliseconds. */
	codeIntelMs: number;
	/** Text searches for something that looks like a symbol. */
	symbol: number;
	/** Text searches for literal text. */
	literal: number;
};

/** Counts for the main conversation and for every subagent together. */
export type Buckets = { main: Counts; subagents: Counts };

/** One counted call: whose it was and what it adds. */
export type Note = { isMain: boolean; counts: Counts };

/** Totals for the local day of the clock value given, and for the 30 days ending with it. */
export type Stats = { today: Counts; last30: Counts };

const FIELDS = ['codeIntel', 'codeIntelMs', 'symbol', 'literal'] as const;

/** Every stored key starts with this, then the local date and the session id. */
const PREFIX = 'adoption:';
const DATED_KEY = /^adoption:(\d{4}-\d{2}-\d{2}):/;

/** How many days, today included, the stored counts are kept and summed. */
const KEPT_DAYS = 30;

function zero(): Counts {
	return { codeIntel: 0, codeIntelMs: 0, symbol: 0, literal: 0 };
}

function empty(): Buckets {
	return { main: zero(), subagents: zero() };
}

function add(into: Counts, counts: Counts): void {
	for (const field of FIELDS) into[field] += counts[field];
}

/** This session's totals. Module state only: a reload of the hooks module starts them over. */
let session = empty();

/**
 * This session's stored entry per day key, as a promise so that calls arriving
 * together share one read of the store. Kept across `resetAdoption()`: the
 * stored day totals belong to the day, not the conversation.
 */
const days = new Map<string, Promise<Buckets>>();

function note(isMain: boolean, counts: Counts): Note {
	add(isMain ? session.main : session.subagents, counts);
	return { isMain, counts };
}

/** Counts one code_intel call in the session totals, with its time when the answer carried one. */
export function noteCodeIntelCall(isMain: boolean, timeMs?: number): Note {
	return note(isMain, { ...zero(), codeIntel: 1, codeIntelMs: typeof timeMs === 'number' ? timeMs : 0 });
}

/** Counts one text search in the session totals, as symbol-like or literal. */
export function noteSearch(isMain: boolean, symbolLike: boolean): Note {
	return note(isMain, { ...zero(), symbol: symbolLike ? 1 : 0, literal: symbolLike ? 0 : 1 });
}

/** This session's totals, as copies. */
export function sessionCounts(): Buckets {
	return { main: { ...session.main }, subagents: { ...session.subagents } };
}

/** The main conversation's counts and the subagents' together. */
export function total(buckets: Buckets): Counts {
	const sum = zero();
	add(sum, buckets.main);
	add(sum, buckets.subagents);
	return sum;
}

/**
 * The share of symbol lookups that went to code_intel: its calls over its calls
 * plus the symbol-like text searches. Literal searches are not lookups
 * code_intel could have answered, so they never enter it. Undefined with nothing to divide.
 */
export function ratio(counts: Counts): number | undefined {
	const lookups = counts.codeIntel + counts.symbol;
	return lookups === 0 ? undefined : counts.codeIntel / lookups;
}

/** `YYYY-MM-DD` for a local year, month (from 0) and day; a day outside the month rolls over. */
function localDate(year: number, month: number, day: number): string {
	const date = new Date(year, month, day, 12);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The first and last local dates the stored counts are summed over at `nowMs`. */
function keptDates(nowMs: number): { oldest: string; today: string } {
	const now = new Date(nowMs);
	const [year, month, day] = [now.getFullYear(), now.getMonth(), now.getDate()];
	return { oldest: localDate(year, month, day - (KEPT_DAYS - 1)), today: localDate(year, month, day) };
}

/**
 * The store key of one session's counts for the local day of `nowMs`. One key
 * per session: the store has no atomic update, so two sessions writing one key
 * would lose each other's counts.
 */
export function dayKey(nowMs: number, sessionId: string): string {
	return `${PREFIX}${keptDates(nowMs).today}:${sessionId}`;
}

function countsOf(value: unknown): Counts | undefined {
	if (!isRecord(value)) return undefined;
	const counts = zero();
	for (const field of FIELDS) {
		const n = num(value[field]);
		if (n === undefined) return undefined;
		counts[field] = n;
	}
	return counts;
}

/** A stored entry, or undefined when the value is not one. */
function bucketsOf(value: unknown): Buckets | undefined {
	if (!isRecord(value)) return undefined;
	const main = countsOf(value.main);
	const subagents = countsOf(value.subagents);
	return main === undefined || subagents === undefined ? undefined : { main, subagents };
}

/**
 * Adds `counted` to this session's entry under `key` and saves it. The first
 * call for a key reads what the store already holds (`(k) => $.store.get(k)`),
 * so a reloaded module or a resumed session adds to its earlier counts; a read
 * that fails is tried again by the next call. `save` is `(k, v) => $.store.set(k, v)`.
 */
export async function persist(
	counted: Note,
	key: string,
	load: (key: string) => Promise<unknown>,
	save: (key: string, entry: Buckets) => Promise<void>,
): Promise<void> {
	let seeded = days.get(key);
	if (seeded === undefined) {
		seeded = load(key).then((stored) => bucketsOf(stored) ?? empty());
		days.set(key, seeded);
		seeded.catch(() => {
			if (days.get(key) === seeded) days.delete(key);
		});
	}
	const entry = await seeded;
	add(counted.isMain ? entry.main : entry.subagents, counted.counts);
	await save(key, entry);
}

/**
 * Sums every session's stored counts for today and for the last 30 days, today
 * included, and deletes the entries older than that. `keys`, `get` and `del`
 * are `await $.store.keys()`, `(k) => $.store.get(k)` and `(k) => $.store.delete(k)`.
 * A key or value that is not this module's is left alone and not counted.
 */
export async function loadStats(
	nowMs: number,
	keys: readonly string[],
	get: (key: string) => Promise<unknown>,
	del: (key: string) => Promise<void>,
): Promise<Stats> {
	const { oldest, today } = keptDates(nowMs);
	const stats: Stats = { today: zero(), last30: zero() };
	for (const key of keys) {
		const date = DATED_KEY.exec(key)?.[1];
		if (date === undefined) continue;
		if (date < oldest) {
			await del(key);
			continue;
		}
		const entry = bucketsOf(await get(key));
		if (entry === undefined) continue;
		const counts = total(entry);
		add(stats.last30, counts);
		if (date === today) add(stats.today, counts);
	}
	return stats;
}

/** Starts the session totals over, for a new conversation (`/clear`, `/resume`, `/branch`). The stored day totals stay. */
export function resetAdoption(): void {
	session = empty();
}

/** Drops the day entries held in memory, as a reload of the hooks module does; the next count reads the store again. */
export function forgetDays(): void {
	days.clear();
}
