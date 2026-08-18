/**
 * Git Repository Mode — the global DEFAULT for new Git stacks.
 *
 * Two distinct concepts:
 *  - **desired** mode: the default new git stacks inherit
 *    (git_repository_desired_mode) or what the DOCKHAND_GIT_CENTRALIZED_MODE env
 *    var demands. Writing it only changes the default for FUTURE stacks — it
 *    never migrates existing stacks and never starts a transition job. Existing
 *    stacks keep their engine until explicitly migrated (git-stack-migrate.ts).
 *  - **effective** mode (git_repository_mode): a legacy value from the retired
 *    whole-fleet transition. Engines/scheduler/webhooks no longer dispatch on
 *    it — per-stack dispatch uses git_stacks.engine. Kept only for the
 *    settings status readout and the getEngine() fallback.
 *
 * getGitMode() never short-circuits on the env var: the env var only
 * contributes to the desired (default) mode.
 */

import { getSetting, setSetting } from './db';

export type GitMode = 'stack' | 'centralized';

export const EFFECTIVE_MODE_SETTING = 'git_repository_mode';
export const DESIRED_MODE_SETTING = 'git_repository_desired_mode';

// Module-level caches — invalidated by setDesiredGitMode. The effective mode is
// a legacy value no longer written at runtime, so caching it here is safe.
let cachedEffective: GitMode | null = null;
let cachedDesired: GitMode | null = null;

function isGitModeValue(value: unknown): value is GitMode {
	return value === 'stack' || value === 'centralized';
}

/** Effective mode — legacy status value, not used for dispatch (see header). */
export async function getGitMode(): Promise<GitMode> {
	if (cachedEffective) return cachedEffective;
	const raw = await getSetting(EFFECTIVE_MODE_SETTING);
	cachedEffective = isGitModeValue(raw) ? raw : 'stack';
	return cachedEffective;
}

/** Desired mode — the default new stacks inherit; env var wins over the UI. */
export async function getDesiredGitMode(): Promise<GitMode> {
	if (cachedDesired) return cachedDesired;
	const envValue = process.env.DOCKHAND_GIT_CENTRALIZED_MODE;
	if (envValue !== undefined && envValue !== '') {
		// Any non-empty env value locks the default; only exact `true` means
		// centralized. `false`/`0`/anything-else force stack mode, so an operator
		// who sets DOCKHAND_GIT_CENTRALIZED_MODE=false explicitly gets stack —
		// never silently stuck centralized with no UI way out (M11).
		cachedDesired = envValue === 'true' ? 'centralized' : 'stack';
		return cachedDesired;
	}
	const raw = await getSetting(DESIRED_MODE_SETTING);
	cachedDesired = isGitModeValue(raw) ? raw : 'stack';
	return cachedDesired;
}

export function isGitModeEnvForced(): boolean {
	// Presence of the variable locks the mode from the UI regardless of its value.
	// `true` forces centralized; any other non-empty value (`false`, `0`, ...)
	// forces stack (see getDesiredGitMode) — either way the UI cannot change it.
	const v = process.env.DOCKHAND_GIT_CENTRALIZED_MODE;
	return v !== undefined && v !== '';
}

/** Set the desired (default) mode. Rejected only when env-forced. */
export async function setDesiredGitMode(mode: GitMode): Promise<void> {
	if (isGitModeEnvForced()) {
		throw new Error('Git repository mode is managed by the DOCKHAND_GIT_CENTRALIZED_MODE environment variable');
	}
	await setSetting(DESIRED_MODE_SETTING, mode);
	cachedDesired = mode;
}

/** Error used for 409-style conflicts. */
export class ConflictError extends Error {}
