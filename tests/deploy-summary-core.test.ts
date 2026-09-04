import { describe, expect, test } from 'bun:test';
import { summarize } from '../src/lib/server/deploy-summary-core';

const REAL_RUN = [
	' Image alpine:3.21 Pulling ',
	' Image alpine:3.21 Pulled ',
	' Image progprobe-built:1 Building ',
	' Image progprobe-built:1 Built ',
	' Network probea_default Creating ',
	' Network probea_default Creating ',
	' Network probea_default Created ',
	' Network probea_default Created ',
	' Container probea-plain-1 Creating ',
	' Container probea-built-1 Creating ',
	' Container probea-built-1 Created ',
	' Container probea-plain-1 Created ',
	' Container probea-built-1 Starting ',
	' Container probea-plain-1 Starting ',
	' Container probea-plain-1 Started ',
	' Container probea-built-1 Started ',
	'#5 CACHED',
	'#6 DONE 1.0s',
	'#7 DONE 2.7s',
	'#9 exporting manifest list sha256:3e3a42937811aaaabbbbccccddddeeeeffff0000111122223333444455556666'
];

describe('summarize', () => {
	test('counts each container once in the measured run', () => {
		const s = summarize(REAL_RUN);
		expect(s.containersCreated).toBe(2);
		expect(s.containersStarted).toBe(2);
		expect(s.containersRecreated).toBe(0);
	});

	// REAL_RUN cannot prove deduplication: in the measured output every container line
	// appears exactly once (only the *network* line repeats, and CONTAINER does not match
	// network lines). Replacing the Set with a counter leaves the test above green. This
	// case supplies the repetition explicitly -- it is the only one that fails when the
	// Set is removed.
	test('counts a container once even when compose repeats the same transition', () => {
		const s = summarize([
			' Container web-1 Created ',
			' Container web-1 Created ',
			' Container web-1 Started ',
			' Container web-1 Started '
		]);
		expect(s.containersCreated).toBe(1);
		expect(s.containersStarted).toBe(1);
	});

	test('separates images built from images pulled', () => {
		const s = summarize(REAL_RUN);
		expect(s.imagesBuilt).toEqual(['progprobe-built:1']);
		expect(s.imagesPulled).toEqual(['alpine:3.21']);
	});

	test('reports how much of the build came from cache', () => {
		const s = summarize(REAL_RUN);
		expect(s.buildSteps).toBe(3);
		expect(s.buildStepsCached).toBe(1);
	});

	test('picks up the image digest from the buildkit export line', () => {
		expect(summarize(REAL_RUN).digest)
			.toBe('sha256:3e3a42937811aaaabbbbccccddddeeeeffff0000111122223333444455556666');
	});

	test('counts recreated containers separately from merely started ones', () => {
		const s = summarize([
			' Container a Recreate ',
			' Container a Recreated ',
			' Container a Starting ',
			' Container a Started '
		]);
		expect(s.containersRecreated).toBe(1);
		expect(s.containersCreated).toBe(0);
	});

	test('an image that was already local produces no pull entry at all', () => {
		// Measured: compose emits neither Pulling nor Pulled for an image that is present.
		// Absence is the only signal, so the summary must not invent one.
		expect(summarize([' Container a Started ']).imagesPulled).toEqual([]);
	});
});
