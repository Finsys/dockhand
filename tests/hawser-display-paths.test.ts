import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { join } from 'node:path';
import {
	remapComposeContentsFromRemoteToStaging,
	remapComposeContentsFromStagingToRemote,
	remapPathsFromRemoteToStaging,
	remapPathsFromStagingToRemote
} from '../src/lib/server/stacks-display-paths';

describe('remapPathsFromStagingToRemote', () => {
	it('remaps compose paths from Dockhand staging to Hawser STACKS_DIR', () => {
		const staging = '/opt/docker/data/dockhand/stacks/nexz447/linkleaner';
		const remote = '/opt/docker/stacks/linkleaner';
		const paths = [
			join(staging, 'compose.yaml'),
			join(staging, 'compose.override.yaml')
		];

		const remapped = remapPathsFromStagingToRemote(staging, remote, paths);

		assert.deepEqual(remapped, [
			join(remote, 'compose.yaml'),
			join(remote, 'compose.override.yaml')
		]);
	});

	it('leaves paths outside the staging dir unchanged', () => {
		const staging = '/data/stacks/prod/myapp';
		const remote = '/opt/stacks/myapp';
		const external = '/srv/custom/myapp/compose.yaml';

		const remapped = remapPathsFromStagingToRemote(staging, remote, [external]);

		assert.deepEqual(remapped, [external]);
	});
});

describe('remapPathsFromRemoteToStaging', () => {
	it('remaps compose paths from Hawser STACKS_DIR back to Dockhand staging', () => {
		const staging = '/opt/docker/data/dockhand/stacks/nexz447/linkleaner';
		const remote = '/opt/docker/stacks/linkleaner';
		const paths = [
			join(remote, 'compose.yaml'),
			join(remote, 'compose.override.yaml')
		];

		const remapped = remapPathsFromRemoteToStaging(staging, remote, paths);

		assert.deepEqual(remapped, [
			join(staging, 'compose.yaml'),
			join(staging, 'compose.override.yaml')
		]);
	});
});

describe('remapComposeContentsFromStagingToRemote', () => {
	it('remaps composeContents keys to remote display paths', () => {
		const staging = '/opt/docker/data/dockhand/stacks/prod/linkleaner';
		const remote = '/opt/docker/stacks/linkleaner';
		const contents = {
			[join(staging, 'compose.yaml')]: 'services:\n  app:\n    image: app',
			[join(staging, 'compose.override.yaml')]: 'services:\n  app:\n    ports:\n      - 8080:80'
		};

		const remapped = remapComposeContentsFromStagingToRemote(staging, remote, contents);

		assert.equal(remapped[join(remote, 'compose.yaml')], contents[join(staging, 'compose.yaml')]);
		assert.equal(
			remapped[join(remote, 'compose.override.yaml')],
			contents[join(staging, 'compose.override.yaml')]
		);
		assert.equal(Object.keys(remapped).length, 2);
	});
});

describe('remapComposeContentsFromRemoteToStaging', () => {
	it('remaps composeContents keys back to staging paths', () => {
		const staging = '/opt/docker/data/dockhand/stacks/prod/linkleaner';
		const remote = '/opt/docker/stacks/linkleaner';
		const contents = {
			[join(remote, 'compose.yaml')]: 'services:\n  app:\n    image: app',
			[join(remote, 'compose.override.yaml')]: 'services:\n  app:\n    ports:\n      - 8080:80'
		};

		const remapped = remapComposeContentsFromRemoteToStaging(staging, remote, contents);

		assert.equal(remapped[join(staging, 'compose.yaml')], contents[join(remote, 'compose.yaml')]);
		assert.equal(
			remapped[join(staging, 'compose.override.yaml')],
			contents[join(remote, 'compose.override.yaml')]
		);
		assert.equal(Object.keys(remapped).length, 2);
	});
});
