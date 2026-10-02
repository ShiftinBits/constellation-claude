import type { Register } from 'claude-code';
import { registerNudges } from './nudge';

export const register: Register = (on, options) => {
	registerNudges(on);
};
