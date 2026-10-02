import type { Register } from 'claude-code';
import { registerDescribe } from './describe';
import { registerNudges } from './nudge';

export const register: Register = (on, options) => {
	registerNudges(on);
	registerDescribe(on);
};
