/**
 * backups/identity.ts — the installation's stable instance id, used to tag every
 * snapshot and helper container so one Dockhand install never reads, prunes, or
 * reaps another's resources on a shared repository or Docker daemon.
 *
 * A UUID persisted in settings, memoised for the process lifetime. The
 * single-flight promise is deliberate: concurrent first callers share ONE
 * resolution so they can't each generate + write a different UUID and split the
 * instance scoping. The pure resolution logic lives in identity-core.ts (no DB
 * import) so it is unit-testable; this wrapper adds the real store + the memo.
 */
import { randomUUID } from 'node:crypto';
import { getSetting, setSetting } from '../db';
import { resolveInstanceId, type InstanceIdStore } from './identity-core';

let cachedInstanceId: string | null = null;
let instanceIdPromise: Promise<string> | null = null;

const store: InstanceIdStore = {
	get: (key) => getSetting(key),
	set: (key, value) => setSetting(key, value),
};

export async function getInstanceId(): Promise<string> {
	if (cachedInstanceId) return cachedInstanceId;
	if (instanceIdPromise) return instanceIdPromise;
	instanceIdPromise = (async () => {
		const id = await resolveInstanceId(store, randomUUID);
		cachedInstanceId = id;
		return id;
	})();
	try {
		return await instanceIdPromise;
	} finally {
		instanceIdPromise = null;
	}
}
