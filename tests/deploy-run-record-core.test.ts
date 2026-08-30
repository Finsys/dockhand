import { describe, expect, test } from 'bun:test';
import { buildRunDetails } from '../src/lib/server/deploy-run-record-core';

describe('buildRunDetails', () => {
	test('carries the options, the summary and the log file name', () => {
		const d = buildRunDetails({
			options: { pull: false, build: true, forceRecreate: true },
			summary: { containersCreated: 2, containersStarted: 2, containersRecreated: 0,
			           imagesBuilt: ['app:1'], imagesPulled: [], buildSteps: 3, buildStepsCached: 1,
			           digest: undefined },
			exitCode: 0,
			composeHash: 'aaa',
			envHash: 'bbb',
			logFile: '01J8-abc.log'
		});
		expect(d.options.build).toBe(true);
		expect(d.summary.containersStarted).toBe(2);
		expect(d.logFile).toBe('01J8-abc.log');
		expect(d.exitCode).toBe(0);
	});

	// The log file name is what ties record and file together. Task 13 deletes any file
	// whose id has no record -- if the name is missing here, the reconciler eats the log.
	test('refuses to build details without a log file name', () => {
		expect(() => buildRunDetails({ options: { pull: false, build: false, forceRecreate: false },
			summary: undefined, exitCode: 0, composeHash: 'a', envHash: 'b', logFile: '' }))
			.toThrow(/logFile/);
	});
});
