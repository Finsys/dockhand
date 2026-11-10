/**
 * The global newer-version settings as stored, merged over the defaults. Pure, so what an
 * absent or partial stored value means is unit-tested.
 */
import type { GlobalSemverConfig } from '../db';

/** `rejectOlderImages` is opt-in: within a rebuild wave a genuine newer tag can be built
 *  minutes before the running image and would be hidden. */
export const DEFAULT_SEMVER_CONFIG: GlobalSemverConfig = {
	enabled: false,
	maxBump: 'major',
	matchFlavor: true,
	includePrerelease: false,
	rejectOlderImages: false
};

export function semverConfigFromSetting(stored: string | null | undefined): GlobalSemverConfig {
	if (!stored) return { ...DEFAULT_SEMVER_CONFIG };
	try {
		return { ...DEFAULT_SEMVER_CONFIG, ...JSON.parse(stored) };
	} catch {
		return { ...DEFAULT_SEMVER_CONFIG };
	}
}
