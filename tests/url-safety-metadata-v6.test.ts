// AWS serves instance metadata on fd00:ec2::254, inside the unique-local range that is
// otherwise an ordinary private (LAN) address.
// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, test, expect } from 'bun:test';
import { ipCategory, dangerousHostReason, isSafeNotificationUrl } from '../src/lib/server/url-safety';

describe('AWS IPv6 metadata address', () => {
	test.each(['fd00:ec2::254', '[fd00:ec2::254]', 'FD00:EC2::254', 'fd00:ec2:0:0:0:0:0:254', 'fd00:0ec2::0254'])(
		'%p is metadata',
		(h) => {
			expect(ipCategory(h)).toBe('metadata');
			expect(dangerousHostReason(h)).toContain('metadata');
		}
	);

	test('the literal is refused in a URL', () => {
		expect(isSafeNotificationUrl('http://[fd00:ec2::254]/latest').ok).toBe(false);
	});

	test.each(['fd00:ec2::253', 'fd00:ec2::1:254', 'fd00::254', 'fd00:ec3::254'])('neighbour %p stays private', (h) => {
		expect(ipCategory(h)).toBe('private');
		expect(dangerousHostReason(h)).toBeNull();
	});
});
