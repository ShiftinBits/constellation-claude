// The values this plugin keeps in the session's `$.state`: what its drawings
// read. Each key's atom names a shape, so every value is declared Shaped<T>; a
// reload whose code names another shape reads the old value as absent.
// Self-contained, as a contract must be: the hooks import these types from here.

/** How often code_intel was called, how long those calls took, and how many text searches ran beside them. */
export type ConstellationCounts = {
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
export type ConstellationBuckets = { main: ConstellationCounts; subagents: ConstellationCounts };

/** Totals for the local day of the clock value given, and for the 30 days ending with it. */
export type ConstellationStats = { today: ConstellationCounts; last30: ConstellationCounts };

export type ConstellationCodeIntelError = {
	code: string;
	message?: string;
	guidance?: readonly string[];
	/** Project roots code_intel found under the git root, sent with `CWD_NOT_INDEXED`. */
	candidates?: readonly string[];
	/** A documentation link the server sends with the error. */
	docs?: string;
};

export type ConstellationCodeIntelEnvelope = {
	success: boolean;
	result?: unknown;
	error?: ConstellationCodeIntelError;
	asOfCommit?: string;
	lastIndexedAt?: string;
	time?: number;
	/** Why a result came back empty (`resultContext.reason`), such as `branch_not_indexed`. */
	reason?: string;
};

/** What the freshness line shows; the key holds null when the graph matches the checkout. */
export type ConstellationFreshnessView =
	| { kind: 'behind'; behind: number; lastIndexedAt?: string }
	| { kind: 'mismatch'; asOfCommit: string; lastIndexedAt?: string }
	| { kind: 'error'; failure: ConstellationCodeIntelError; lastIndexedAt?: string };

/** The onboarding band's states. The first that holds wins, in this order. */
export type ConstellationOnboardingState = 'not-set-up' | 'sign-in-again' | 'no-project' | 'not-registered' | 'not-indexed' | 'working';

/** A CLI run the band starts. */
export type ConstellationTask = 'auth' | 'index';

/** What the onboarding band draws. Empty when it shows nothing. */
export type ConstellationBand = {
	state?: ConstellationOnboardingState;
	/** The CLI run behind `working`. */
	task?: ConstellationTask;
	/** The line under the headline: the running CLI's latest output line, then the line its run ended on. */
	detail?: string;
	/** The address a running sign-in asks to be opened when no browser opened. */
	url?: string;
	/** The last press found no CLI: the band says how to install it. */
	cliMissing?: boolean;
};

/** A tab of the `/constellation` pane. */
export type ConstellationTab = 'status' | 'diagnose' | 'deps' | 'unused' | 'explore' | 'stats';

/** A tab that shows a code_intel query's answer. Stats shows counts kept on this machine and never queries. */
export type ConstellationQueryTab = Exclude<ConstellationTab, 'stats'>;

/** Which way the Deps tab reads a file's imports. */
export type ConstellationDirection = 'dependencies' | 'dependents';

/** The detail view of a symbol the Explore tab drilled into. */
export type ConstellationSection = 'details' | 'usages' | 'impact' | 'calls';

/** The color scheme the pane draws with, from Claude Code's theme. */
export type ConstellationScheme = 'brand' | 'brand-light' | 'theme';

/** One symbol a search found, as the explorer lists and drills into it. */
export type ConstellationHit = {
	id: string;
	name: string;
	kind: string;
	filePath: string;
	line?: number;
};

/** One unused export as the pane lists it and the removal prompt names it. */
export type ConstellationOrphanRow = {
	symbolId: string;
	name: string;
	kind: string;
	filePath: string;
	/** The graph holds no start line, only the end line, and not for every symbol. */
	lineEnd?: number;
};

/** What the `/constellation` pane draws: its tab, each tab's answer and what the person selected. */
export type ConstellationPane = {
	tab: ConstellationTab;
	tint: ConstellationScheme;
	/** The directory the queries run in: the session's, or the project picked from it. */
	cwd?: string;
	/** The session's directory when the pane opened. */
	launchCwd?: string;
	/** Each query tab's answer. */
	results: Partial<Record<ConstellationQueryTab, ConstellationCodeIntelEnvelope>>;
	/** The project picker's `getCapabilities` answers, by project root. */
	details: Record<string, ConstellationCodeIntelEnvelope>;
	depsPath: string;
	direction: ConstellationDirection;
	/** The kind the Unused tab lists; every kind when absent. */
	unusedKind?: string;
	/** The Unused picker's selected symbol ids. */
	picked: string[];
	/** The Unused pages loaded after the first. */
	morePages: ConstellationOrphanRow[];
	nextOffset?: number;
	handoffNote?: string;
	/** The symbol the explorer searches for. */
	query: string;
	/** The hit the explorer drilled into, and the section it shows. */
	focus?: ConstellationHit;
	section: ConstellationSection;
	/** Each drilled symbol's answer, by symbol id. */
	drill: Record<string, ConstellationCodeIntelEnvelope>;
	exploreNote?: string;
	/** The Stats tab's counts, the session's and the stored ones read together; `stored` is absent when the store cannot be read. */
	stats?: { session: ConstellationBuckets; stored?: ConstellationStats };
};

declare module 'claude-code' {
	interface PluginState {
		constellation: {
			/** This session's adoption counts, which the spinner and the Stats tab draw. */
			adoption: Shaped<ConstellationBuckets>;
			/** The index freshness line, null when there is none. */
			freshness: Shaped<ConstellationFreshnessView | null>;
			/** The onboarding band above the prompt. */
			band: Shaped<ConstellationBand>;
			/** The `/constellation` pane. */
			pane: Shaped<ConstellationPane>;
		};
	}
}
