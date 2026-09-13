/**
 * Pure permission mapping for reading schedule_executions rows. No imports, so
 * it stays unit-testable without the DB/auth module chain.
 *
 * A schedule execution's row (its errorMessage, details, and full logs) is only
 * as sensitive as the thing it ran, so reading it is gated by the SAME resource
 * permission that gates the underlying feature -- NOT a single blanket
 * 'schedules:view'. That would either over-restrict (a backups-only viewer
 * loses backup run stats) or under-restrict (a schedules-only viewer reads
 * compose stderr from a stack deploy they can't otherwise see). Deploy stderr
 * can carry redacted-but-not-guaranteed-clean output, hence the care.
 */

export type ScheduleExecResource = 'stacks' | 'backups' | 'schedules';

/** Every schedule type that maps to a NON-generic resource. Types not listed here
 *  fall through to 'schedules' in resourceForScheduleType. Kept here (not inlined)
 *  so the list gate can enumerate which types a resource-scoped caller may see. */
const NON_GENERIC_TYPES: Record<string, ScheduleExecResource> = {
	stack_deploy: 'stacks',
	git_stack_sync: 'stacks',
	backup: 'backups',
	restore: 'backups'
};

/**
 * The resource whose `:view` permission a caller must hold to read executions of
 * this schedule type. Unknown/unrecognized types fall back to 'schedules' -- the
 * generic bucket, never a weaker one.
 */
export function resourceForScheduleType(scheduleType: string): ScheduleExecResource {
	return NON_GENERIC_TYPES[scheduleType] ?? 'schedules';
}

/**
 * The concrete schedule types whose executions a caller may read given which
 * resource :view permissions they hold. Used to bound a NO-scheduleType-filter
 * list query so a caller never receives errorMessage/details of a type they lack
 * permission for.
 *
 * Returns null when 'schedules' AND 'stacks' AND 'backups' are all viewable --
 * i.e. every type is allowed, so no type filter is needed (null = "do not
 * filter", matching getScheduleExecutions' scheduleTypes semantics). Otherwise
 * returns the explicit allow-list: the always-generic types when 'schedules' is
 * held, plus each NON_GENERIC type whose resource is held.
 *
 * `allKnownTypes` is passed in (the caller has the ScheduleType union) so this
 * stays dependency-free and testable.
 */
export function viewableScheduleTypes(
	viewable: { schedules: boolean; stacks: boolean; backups: boolean },
	allKnownTypes: readonly string[]
): string[] | null {
	if (viewable.schedules && viewable.stacks && viewable.backups) return null;
	const allowed: string[] = [];
	for (const t of allKnownTypes) {
		const resource = resourceForScheduleType(t);
		if (viewable[resource]) allowed.push(t);
	}
	return allowed;
}
