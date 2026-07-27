/**
 * Pure core of the backup operation journal — NO database import, so it is unit
 * testable under bun test (journal.ts pulls better-sqlite3 transitively and
 * cannot be). All persistence is behind the injected `JournalStore` interface;
 * journal.ts supplies the settings-backed implementation.
 *
 * The property this core encodes and the tests pin: record/clear/list operate on
 * PER-KEY rows (one settings row per operation id), so two concurrent records
 * never lost-update each other the way a single shared JSON array would.
 */
import { randomUUID } from 'crypto';

/** One durable row per key. `backup:op:<id>`. */
export const OP_KEY_PREFIX = 'backup:op:';

/** The kinds of in-flight operation the journal records. */
export type OpKind = 'swap' | 'stop';

export interface OperationRecord {
	id: string;
	kind: OpKind;
	instanceId: string;
	envId?: number | null;
	startedAt: string;
	// kind: 'stop'
	stopType?: 'stack' | 'container';
	targetName?: string;
	containerId?: string;
	configId?: number;
	/** For a 'stop' of type 'container': the ids/names that were running and got
	 * stopped, so a fresh process can start exactly those back up. */
	containers?: Array<{ id: string; name: string }>;
	// kind: 'swap'
	snapshotId?: string;
	includes?: string[];
	volumeBinds?: string[];
}

/** Minimal per-key settings store the core depends on (injected). */
export interface JournalStore {
	get(key: string): Promise<any>;
	set(key: string, value: any): Promise<void>;
	delete(key: string): Promise<void>;
	listByPrefix(prefix: string): Promise<Array<{ key: string; value: any }>>;
}

export function rowKey(id: string): string {
	return OP_KEY_PREFIX + id;
}

export async function recordOperationIn(
	store: JournalStore,
	rec: Omit<OperationRecord, 'id'> & { id?: string }
): Promise<string> {
	const id = rec.id ?? randomUUID();
	const full: OperationRecord = { ...rec, id };
	try {
		// Single-key upsert. No read-modify-write of a shared row → no lost update.
		await store.set(rowKey(id), full);
	} catch (err) {
		console.warn(`[Backup] Could not persist ${rec.kind} operation ${id}: ${err instanceof Error ? err.message : String(err)}`);
	}
	return id;
}

export async function clearOperationIn(store: JournalStore, id: string): Promise<void> {
	try {
		await store.delete(rowKey(id));
	} catch { /* best-effort */ }
}

export async function listOperationsIn(
	store: JournalStore,
	kind?: OpKind,
	instanceId?: string
): Promise<OperationRecord[]> {
	let rows: Array<{ key: string; value: any }>;
	try {
		rows = await store.listByPrefix(OP_KEY_PREFIX);
	} catch {
		return [];
	}
	const out: OperationRecord[] = [];
	for (const r of rows) {
		const rec = r.value as OperationRecord;
		if (!rec || typeof rec !== 'object' || !rec.kind) continue;
		if (kind && rec.kind !== kind) continue;
		if (instanceId && rec.instanceId !== instanceId) continue;
		out.push(rec);
	}
	return out;
}
