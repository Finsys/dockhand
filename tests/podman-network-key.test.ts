import { describe, test, expect } from 'bun:test';
import { isUnknownNetworkKeyError, retryEndpointKey } from '../src/lib/server/podman-network-key';

describe('isUnknownNetworkKeyError', () => {
	test('matches what Podman actually returns for a rejected endpoint key', () => {
		// Verbatim from Podman 5.4.2 on a create keyed by "bridge".
		expect(
			isUnknownNetworkKeyError(
				'container create: unable to find network with name or ID bridge: network not found'
			)
		).toBe(true);
	});

	test('matches regardless of which network name is named', () => {
		expect(
			isUnknownNetworkKeyError('unable to find network with name or ID my-net: network not found')
		).toBe(true);
	});

	test('other create failures are left alone, so the retry stays narrow', () => {
		expect(isUnknownNetworkKeyError('No such image: alpine:latest')).toBe(false);
		expect(isUnknownNetworkKeyError('Conflict. The container name is already in use')).toBe(false);
		expect(isUnknownNetworkKeyError('invalid IP address in add-host')).toBe(false);
		expect(isUnknownNetworkKeyError('network not found')).toBe(false);
	});

	test('Docker rejecting aliases on the default bridge does not trigger a retry', () => {
		// Verbatim from Docker 29.4.1. It also names a network and also concerns
		// endpoint settings, so it is the nearest thing to a false positive.
		expect(
			isUnknownNetworkKeyError(
				'invalid config for network bridge: invalid endpoint settings:\nnetwork-scoped aliases are only supported for user-defined networks'
			)
		).toBe(false);
	});

	test('a missing or non-string message never triggers a retry', () => {
		expect(isUnknownNetworkKeyError(undefined)).toBe(false);
		expect(isUnknownNetworkKeyError(null)).toBe(false);
		expect(isUnknownNetworkKeyError('')).toBe(false);
		expect(isUnknownNetworkKeyError(42 as never)).toBe(false);
	});
});

describe('retryEndpointKey', () => {
	const PODMAN_ERR =
		'container create: unable to find network with name or ID bridge: network not found';

	test('the aliased bridge retries by id', () => {
		expect(
			retryEndpointKey({
				message: PODMAN_ERR,
				endpoints: { bridge: { Aliases: ['web'] } },
				key: 'bridge',
				networkId: '2f259bab93aa'
			})
		).toBe('2f259bab93aa');
	});

	test('a network that does not exist rethrows instead of retrying', () => {
		// Podman words a typo exactly like the bridge bug, so the message alone
		// cannot tell them apart - the absent id is what does. Both shapes the
		// lookup can return for "no such network" must refuse the retry.
		for (const networkId of [null, undefined, '']) {
			expect(
				retryEndpointKey({
					message: 'unable to find network with name or ID typo-net: network not found',
					endpoints: { 'typo-net': {} },
					key: 'typo-net',
					networkId
				})
			).toBeNull();
		}
	});

	test('an id equal to the key means there is nothing to retry with', () => {
		expect(
			retryEndpointKey({
				message: PODMAN_ERR,
				endpoints: { bridge: {} },
				key: 'bridge',
				networkId: 'bridge'
			})
		).toBeNull();
	});

	test('a key absent from the payload is not ours to rewrite', () => {
		expect(
			retryEndpointKey({
				message: PODMAN_ERR,
				endpoints: { 'some-other-net': {} },
				key: 'bridge',
				networkId: '2f259bab93aa'
			})
		).toBeNull();
		expect(
			retryEndpointKey({ message: PODMAN_ERR, endpoints: undefined, key: 'bridge', networkId: 'x' })
		).toBeNull();
	});

	test('an unrelated failure never retries, whatever the lookup returned', () => {
		expect(
			retryEndpointKey({
				message: 'No such image: alpine:latest',
				endpoints: { bridge: {} },
				key: 'bridge',
				networkId: '2f259bab93aa'
			})
		).toBeNull();
	});
});
