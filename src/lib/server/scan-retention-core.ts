/**
 * Which vulnerability scans are worth keeping.
 *
 * Scans are append-only and each carries its whole findings document, so a host
 * that scans nightly accumulates gigabytes of results nobody reads. What is
 * actually needed is the current state of each image, enough history for the
 * scan export, and nothing at all for images the host no longer has.
 *
 * Pure decisions, so the rules are testable without a database.
 */

export interface RetentionPolicy {
	/** Newest scans kept per image and scanner. */
	keepPerImage: number;
	/** How long a scan survives after its image disappears from every host. */
	graceDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
	// The scan export shows up to ten, so keeping ten leaves it whole.
	keepPerImage: 10,
	// An image can be missing briefly - a rebuild, or a prune before a pull - and
	// its history should survive that.
	graceDays: 7
};

/** A scan row reduced to what the decision needs. */
export interface ScanRecord {
	id: number;
	environmentId: number | null;
	imageId: string;
	scanner: string;
	scannedAt: string;
}

export interface RetentionPlan {
	deleteIds: number[];
	/** Rows dropped because a newer scan of the same image supersedes them. */
	supersededCount: number;
	/** Rows dropped because their image is gone from the host. */
	goneImageCount: number;
}

function pairKey(scan: ScanRecord): string {
	return `${scan.environmentId ?? 'local'} ${scan.imageId} ${scan.scanner}`;
}

/**
 * Decide which of `scans` to drop.
 *
 * `liveImageIds` holds every image present on an environment that answered.
 * `reachableEnvIds` is which environments those were: an environment that could
 * not be reached contributes no images, and without this its scans would all
 * look like they belong to vanished images.
 */
export function planRetention(
	scans: ScanRecord[],
	liveImageIds: ReadonlySet<string>,
	reachableEnvIds: ReadonlySet<number | null>,
	now: Date,
	policy: RetentionPolicy = DEFAULT_RETENTION
): RetentionPlan {
	const keep = Math.max(1, Math.floor(policy.keepPerImage));
	const cutoff = now.getTime() - Math.max(0, policy.graceDays) * 24 * 60 * 60 * 1000;

	const byPair = new Map<string, ScanRecord[]>();
	for (const scan of scans) {
		const key = pairKey(scan);
		const list = byPair.get(key);
		if (list) list.push(scan);
		else byPair.set(key, [scan]);
	}

	const deleteIds: number[] = [];
	let supersededCount = 0;
	let goneImageCount = 0;

	for (const group of byPair.values()) {
		// Newest first, the id breaking a tie so the order is deterministic.
		group.sort((a, b) =>
			a.scannedAt === b.scannedAt ? b.id - a.id : a.scannedAt < b.scannedAt ? 1 : -1
		);

		const sample = group[0];
		const envAnswered = reachableEnvIds.has(sample.environmentId);
		const imageGone = envAnswered && !liveImageIds.has(sample.imageId);

		if (imageGone && Date.parse(sample.scannedAt) < cutoff) {
			// Nothing here can be displayed or compared against again.
			for (const scan of group) deleteIds.push(scan.id);
			goneImageCount += group.length;
			continue;
		}

		for (const scan of group.slice(keep)) {
			deleteIds.push(scan.id);
			supersededCount++;
		}
	}

	return { deleteIds, supersededCount, goneImageCount };
}

/**
 * Whether an environment's image list is trustworthy enough to delete on.
 *
 * A daemon that fails is obviously no evidence, but so is one that answers with
 * nothing: a fresh store, a prune, or a host still starting all report zero
 * images, and acting on that would drop the environment's whole scan history.
 */
export function answerIsUsable(images: { length: number } | null | undefined): boolean {
	return !!images && images.length > 0;
}

/**
 * Strip what a findings document may contain but a database column cannot hold.
 *
 * A scanner can report a NUL or a lone surrogate inside a CVE description. Both
 * survive JSON.stringify as valid escapes, so nothing upstream rejects them, but
 * PostgreSQL refuses to convert either to text and fails every statement that
 * reads the row. They carry no meaning in a description, so they go.
 *
 * Done on the parsed value rather than the text: an escape sequence and a
 * literal backslash followed by the same letters look alike in the source, and
 * editing the text cannot tell them apart without re-implementing the parser.
 */
export function stripUnstorableEscapes(json: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return json; // not ours to repair
	}

	let touched = false;
	const clean = (value: unknown): unknown => {
		if (typeof value === 'string') {
			// Drop NULs and any surrogate not paired with its other half.
			const out = value
				.replace(/\u0000/g, '')
				.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '')
				.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
			if (out !== value) touched = true;
			return out;
		}
		if (Array.isArray(value)) return value.map(clean);
		if (value && typeof value === 'object') {
			const out: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(value)) out[clean(k) as string] = clean(v);
			return out;
		}
		return value;
	};

	const cleaned = clean(parsed);
	return touched ? JSON.stringify(cleaned) : json;
}
