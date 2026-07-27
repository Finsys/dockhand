/**
 * Durable operation journal for the backup/restore domain — settings-backed
 * adapter over the pure core in journal-core.ts.
 *
 * Each in-flight operation gets its OWN settings row keyed `backup:op:<id>`:
 * record = single-key upsert; clear = single-key delete; list = prefix scan. Two
 * distinct operation ids write distinct rows and so can never lost-update each
 * other — the failure mode a single shared JSON array mutated by a lock-free
 * read-filter-write suffers under concurrency. The row carries the owning
 * instanceId so a list can be scoped to this installation. The record shape lives
 * in journal-core.ts (no db import) so it is unit-testable.
 *
 * This module is a LEAF: it depends only on the settings store, so it never
 * imports the pipelines that use it (no cycle).
 */
import { getSetting, setSetting, deleteSetting, listSettingsByPrefix } from '../db';
import {
	recordOperationIn, clearOperationIn, listOperationsIn,
	type JournalStore, type OperationRecord, type OpKind,
} from './journal-core';

export type { OperationRecord, OpKind } from './journal-core';

/** The production store: dockhand's settings table. */
const settingsStore: JournalStore = {
	get: (key) => getSetting(key),
	set: (key, value) => setSetting(key, value),
	delete: (key) => deleteSetting(key),
	listByPrefix: (prefix) => listSettingsByPrefix(prefix),
};

export function recordOperation(rec: Omit<OperationRecord, 'id'> & { id?: string }): Promise<string> {
	return recordOperationIn(settingsStore, rec);
}

export function clearOperation(id: string): Promise<void> {
	return clearOperationIn(settingsStore, id);
}

export function listOperations(kind?: OpKind, instanceId?: string): Promise<OperationRecord[]> {
	return listOperationsIn(settingsStore, kind, instanceId);
}
