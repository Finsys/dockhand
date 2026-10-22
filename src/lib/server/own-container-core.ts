/**
 * Whether a request is aiming at the container Dockhand itself runs in.
 *
 * Changing Dockhand's own networking is not the same kind of act as changing an
 * application's: the update helper reconnects the replacement container to whatever
 * networks it finds, so what is attached here is read later by a privileged step.
 * Attaching a network is a permission of its own, so without this an account that
 * holds it could arrange that input without holding the administrator role.
 *
 * Pure, so the matching rules are a unit test rather than something only a
 * misidentified container reveals.
 */

/** A docker id: 64 hex characters, or the 12-character short form. */
function isDockerId(value: string): boolean {
	return /^[a-f0-9]{12}$|^[a-f0-9]{64}$/.test(value);
}

/**
 * True when `resolvedId` is the id of the container Dockhand runs in.
 *
 * Both sides must be real ids. Docker accepts a NAME wherever it accepts an id, and a
 * name can be reassigned between this check and the act it guards, so the caller
 * resolves whatever it was given to an id first and passes that here. An unknown own
 * identity is false: guessing would refuse legitimate work on some other container.
 */
export function targetsOwnContainer(
	resolvedId: string | null | undefined,
	own: { id?: string | null }
): boolean {
	if (typeof resolvedId !== 'string') return false;
	const t = resolvedId.trim().toLowerCase();
	const ownId = own.id?.trim().toLowerCase();
	if (!t || !ownId || !isDockerId(t) || !isDockerId(ownId)) return false;

	// Either may be the short form, so compare over the shorter length.
	const n = Math.min(t.length, ownId.length);
	return t.slice(0, n) === ownId.slice(0, n);
}
