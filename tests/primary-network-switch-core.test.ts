import { describe, expect, it } from 'bun:test';
import {
	rescopeForPrimarySwitch,
	type NetworkScopedOptions
} from '../src/lib/server/primary-network-switch-core';

/**
 * The state the bug needs: a container on `r2a` that also holds a static address on
 * `r2b`. Measured from a real inspect (docker 29.4.0) of
 *   docker run --network r2a ... && docker network connect --ip 10.55.0.7 r2b ...
 */
function containerOnTwoNetworks(): NetworkScopedOptions {
	return {
		networkAliases: ['web'],
		networkIpv4Address: '192.168.214.2',
		networkGwPriority: 5,
		macAddress: 'da:89:50:fc:4a:d5',
		additionalNetworks: ['r2b'],
		networkConfigs: {
			r2b: { aliases: ['r2web'], ipv4Address: '10.55.0.7' }
		}
	};
}

describe('rescopeForPrimarySwitch', () => {
	describe('promoting an existing extra to primary', () => {
		it("keeps that network's own static address instead of dropping it", () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b');
			// Without the handover the daemon assigns a fresh lease (measured: 10.55.0.2).
			expect(out.networkIpv4Address).toBe('10.55.0.7');
		});

		it("keeps that network's own aliases", () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b');
			expect(out.networkAliases).toEqual(['r2web']);
		});

		it('stops listing the new primary as an extra', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b');
			// createContainer rejects a network that is both the primary and an extra.
			expect(out.additionalNetworks).toEqual([]);
			expect(out.networkConfigs).toEqual({});
		});

		it('does not carry the old primary values across', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b');
			expect(out.networkIpv4Address).not.toBe('192.168.214.2');
			expect(out.networkAliases).not.toContain('web');
		});
	});

	describe("promoting with the caller's own edits in the same save", () => {
		// The edit form sends a network's address in networkConfigs and never in the
		// primary fields, so the request's entry has to beat the one read from the
		// container or the edit is silently discarded.
		const edited = { networkConfigs: { r2b: { ipv4Address: '10.55.0.99' } } };

		it('uses the address the caller asked for', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b', edited);
			expect(out.networkIpv4Address).toBe('10.55.0.99');
		});

		it('treats an omitted entry as cleared rather than reviving the old address', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b', {
				networkConfigs: {}
			});
			expect(out.networkIpv4Address).toBeUndefined();
			expect(out.networkAliases).toBeUndefined();
		});

		it('still reads the container when the caller sends no networkConfigs at all', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b', {});
			expect(out.networkIpv4Address).toBe('10.55.0.7');
		});
	});

	describe('switching to a network the container is not on', () => {
		it('drops the old per-network values rather than reapplying them', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'brand-new');
			// Compose aliases on the default bridge come back as "invalid endpoint settings".
			expect(out.networkAliases).toBeUndefined();
			expect(out.networkIpv4Address).toBeUndefined();
			expect(out.networkIpv6Address).toBeUndefined();
		});

		it('leaves the untouched extras attached', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'brand-new');
			expect(out.additionalNetworks).toEqual(['r2b']);
			expect(out.networkConfigs).toEqual({
				r2b: { aliases: ['r2web'], ipv4Address: '10.55.0.7' }
			});
		});
	});

	describe('fields that never survive a switch', () => {
		it('drops the gateway priority and the MAC', () => {
			const out = rescopeForPrimarySwitch(containerOnTwoNetworks(), 'r2b');
			// A priority is meaningless against a different set of attachments, and a
			// carried MAC collides once another container inherits the old address.
			expect(out.networkGwPriority).toBeUndefined();
			expect(out.macAddress).toBeUndefined();
		});
	});

	describe('shapes that must not throw', () => {
		it('handles a container with no extras at all', () => {
			const out = rescopeForPrimarySwitch(
				{ networkAliases: ['solo'], networkIpv4Address: '10.0.0.5' },
				'other'
			);
			expect(out.networkAliases).toBeUndefined();
			expect(out.networkIpv4Address).toBeUndefined();
			expect(out.additionalNetworks).toBeUndefined();
			expect(out.networkConfigs).toBeUndefined();
		});

		it('handles an extra that carries no settings of its own', () => {
			const out = rescopeForPrimarySwitch(
				{ networkIpv4Address: '10.0.0.5', additionalNetworks: ['plain'], networkConfigs: {} },
				'plain'
			);
			expect(out.networkIpv4Address).toBeUndefined();
			expect(out.additionalNetworks).toEqual([]);
		});

		it('promotes an ipv6-only extra', () => {
			const out = rescopeForPrimarySwitch(
				{ additionalNetworks: ['v6net'], networkConfigs: { v6net: { ipv6Address: 'fd00::7' } } },
				'v6net'
			);
			expect(out.networkIpv6Address).toBe('fd00::7');
			expect(out.networkIpv4Address).toBeUndefined();
		});

		it("leaves the caller's options object untouched", () => {
			const input = containerOnTwoNetworks();
			rescopeForPrimarySwitch(input, 'r2b');
			expect(input.networkIpv4Address).toBe('192.168.214.2');
			expect(input.additionalNetworks).toEqual(['r2b']);
		});
	});

	describe('unrelated options', () => {
		it('passes through fields this decision does not own', () => {
			const out = rescopeForPrimarySwitch(
				{ ...containerOnTwoNetworks(), image: 'nginx:latest' } as NetworkScopedOptions & {
					image: string;
				},
				'r2b'
			);
			expect(out.image).toBe('nginx:latest');
		});
	});
});
