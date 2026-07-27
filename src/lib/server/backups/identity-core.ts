/**
 * Pure core of installation-identity resolution — NO database import, so it is
 * unit-testable under bun test. Persistence and id generation are injected; the
 * DB-backed wrapper (identity.ts) supplies the real settings store + randomUUID.
 *
 * The single-flight promise is the load-bearing property: concurrent first
 * callers must share ONE resolution. Without it, two callers that both find no
 * stored id would each generate a DIFFERENT UUID and each write it, leaving rows
 * tagged under conflicting instance ids and splitting instance scoping.
 */

/** Minimal settings surface identity resolution needs (injected). */
export interface InstanceIdStore {
	get(key: string): Promise<unknown>;
	set(key: string, value: string): Promise<void>;
}

const SETTING_KEY = 'backup_instance_id';

/**
 * Resolve (and, if absent, generate + persist) the installation's instance id.
 * `generateId` is injected so tests are deterministic. This holds no cache of its
 * own — the memoization lives in the DB-backed wrapper so tests don't leak state.
 */
export async function resolveInstanceId(
	store: InstanceIdStore,
	generateId: () => string
): Promise<string> {
	const existing = await store.get(SETTING_KEY);
	if (typeof existing === 'string' && existing.length > 0) {
		return existing;
	}
	const fresh = generateId();
	await store.set(SETTING_KEY, fresh);
	return fresh;
}
