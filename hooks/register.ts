import type { Register } from 'claude-code';
import { registerAugment } from './augment';
import { registerBudget } from './budget';
import { registerCommand } from './command';
import { registerDescribe } from './describe';
import { registerImpactGate } from './impact';
import { registerNudges } from './nudge';
import { registerSession } from './session';

export const register: Register = (on, options) => {
	registerBudget(on, options);
	registerNudges(on);
	registerDescribe(on);
	registerAugment(on, options);
	registerSession(on);
	registerCommand(on, options);
	registerImpactGate(on, options);
};
