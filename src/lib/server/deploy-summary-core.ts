/**
 * Condenses compose output into the few facts an operator actually asks after a deploy:
 * was anything built or did it all come from cache, was an image pulled or was it already
 * there, were containers recreated or merely restarted, and which digest is running now.
 *
 * Deliberately dependency-free so it can be unit tested under Bun, which cannot import
 * the modules that pull in the native database binding.
 *
 * Compose repeats state transitions when no TTY is attached -- the same "Created" line can
 * appear twice -- so every count is over a Set of names, never over line occurrences.
 */
export interface DeploySummary {
	containersCreated: number;
	containersRecreated: number;
	containersStarted: number;
	imagesBuilt: string[];
	imagesPulled: string[];
	buildSteps: number;
	buildStepsCached: number;
	digest?: string;
}

const CONTAINER = /^\s*Container\s+(\S+)\s+(Created|Recreated|Started)\s*$/;
const IMAGE = /^\s*Image\s+(\S+)\s+(Built|Pulled)\s*$/;
const BUILD_DONE = /^#\d+\s+DONE\s/;
const BUILD_CACHED = /^#\d+\s+CACHED\s*$/;
const DIGEST = /exporting manifest list (sha256:[0-9a-f]{64})/;

export function summarize(lines: string[]): DeploySummary {
	const created = new Set<string>();
	const recreated = new Set<string>();
	const started = new Set<string>();
	const built = new Set<string>();
	const pulled = new Set<string>();
	let buildSteps = 0;
	let buildStepsCached = 0;
	let digest: string | undefined;

	for (const line of lines) {
		const c = CONTAINER.exec(line);
		if (c) {
			const [, name, verb] = c;
			if (verb === 'Created') created.add(name);
			else if (verb === 'Recreated') recreated.add(name);
			else started.add(name);
			continue;
		}
		const i = IMAGE.exec(line);
		if (i) {
			const [, name, verb] = i;
			(verb === 'Built' ? built : pulled).add(name);
			continue;
		}
		if (BUILD_CACHED.test(line)) { buildSteps++; buildStepsCached++; continue; }
		if (BUILD_DONE.test(line)) { buildSteps++; continue; }
		const d = DIGEST.exec(line);
		if (d) digest = d[1];
	}

	return {
		containersCreated: created.size,
		containersRecreated: recreated.size,
		containersStarted: started.size,
		imagesBuilt: [...built],
		imagesPulled: [...pulled],
		buildSteps,
		buildStepsCached,
		digest
	};
}
