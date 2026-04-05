import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getAdditionalVolumeBinds } from './mount-dedupe';

describe('getAdditionalVolumeBinds', () => {
	it('skips volume mounts when the target already exists in HostConfig.Mounts', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{
				Binds: ['/volume1/backups:/backup'],
				Mounts: [{ Target: '/data' }]
			},
			[
				{ Type: 'volume', Name: 'docsight_docsis_data', Destination: '/data' },
				{ Type: 'bind', Name: 'ignored', Destination: '/backup' }
			]
		);

		assert.deepEqual(additionalBinds, []);
	});

	it('adds volume mounts that are missing from HostConfig', () => {
		const additionalBinds = getAdditionalVolumeBinds(
			{
				Binds: ['/volume1/backups:/backup'],
				Mounts: []
			},
			[{ Type: 'volume', Name: 'docsight_docsis_data', Destination: '/data' }]
		);

		assert.deepEqual(additionalBinds, ['docsight_docsis_data:/data']);
	});
});
