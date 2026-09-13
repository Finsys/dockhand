/**
 * Unit tests for detectImageEnvDivergence and detectImageLabelDivergence.
 *
 * Both helpers report keys whose container value differs from the
 * image's CURRENT value. Keys present on only one side are NOT
 * reported — those are user-only or image-only, neither of which is
 * a divergence between sides we can act on.
 */

import { describe, test, expect } from 'bun:test';
import {
	detectImageEnvDivergence,
	detectImageLabelDivergence
} from '../src/lib/server/container-image-divergence';

describe('detectImageEnvDivergence', () => {
	test('returns [] when arrays match', () => {
		expect(detectImageEnvDivergence(['A=1', 'B=2'], ['A=1', 'B=2'])).toEqual([]);
	});

	test('returns [] for empty inputs', () => {
		expect(detectImageEnvDivergence([], [])).toEqual([]);
		expect(detectImageEnvDivergence(['A=1'], [])).toEqual([]);
		expect(detectImageEnvDivergence([], ['A=1'])).toEqual([]);
	});

	test('returns differing keys', () => {
		const result = detectImageEnvDivergence(
			['PORT=80', 'NGINX_VERSION=1.27.3', 'PATH=/usr/bin'],
			['PORT=8080', 'NGINX_VERSION=1.27.4', 'PATH=/usr/bin']
		);
		expect(result.sort()).toEqual(['NGINX_VERSION', 'PORT']);
	});

	test('does NOT report keys present in only one side', () => {
		// USER_ONLY appears only in the container — user-set, not divergence
		// IMAGE_ONLY appears only in the image — image-added, not divergence
		const result = detectImageEnvDivergence(
			['USER_ONLY=foo', 'PATH=/usr/bin'],
			['IMAGE_ONLY=bar', 'PATH=/usr/bin']
		);
		expect(result).toEqual([]);
	});

	test('handles values containing =', () => {
		const result = detectImageEnvDivergence(
			['CONFIG=a=b=c', 'OTHER=ok'],
			['CONFIG=x=y=z', 'OTHER=ok']
		);
		expect(result).toEqual(['CONFIG']);
	});

	test('handles empty values', () => {
		expect(detectImageEnvDivergence(['EMPTY='], ['EMPTY=set'])).toEqual(['EMPTY']);
		expect(detectImageEnvDivergence(['EMPTY='], ['EMPTY='])).toEqual([]);
	});

	test('handles entries with no = (treated as empty value)', () => {
		// Bare "KEY" entries are valid in Docker env arrays — treat as KEY=""
		expect(detectImageEnvDivergence(['BARE'], ['BARE='])).toEqual([]);
		expect(detectImageEnvDivergence(['BARE'], ['BARE=value'])).toEqual(['BARE']);
	});

	test('reporter scenarios from #1135 and #1061', () => {
		// #1135: user overrode image's ASPNETCORE_HTTP_PORTS=8080 to 80
		expect(
			detectImageEnvDivergence(['ASPNETCORE_HTTP_PORTS=80'], ['ASPNETCORE_HTTP_PORTS=8080'])
		).toEqual(['ASPNETCORE_HTTP_PORTS']);

		// #1061: container was created when image had APP_VERSION=0.32.0;
		// image now has 0.36.0
		expect(
			detectImageEnvDivergence(['APP_VERSION=0.32.0'], ['APP_VERSION=0.36.0'])
		).toEqual(['APP_VERSION']);
	});
});

describe('detectImageLabelDivergence', () => {
	test('returns [] when objects match', () => {
		expect(detectImageLabelDivergence({ a: '1', b: '2' }, { a: '1', b: '2' })).toEqual([]);
	});

	test('returns [] for nullish inputs', () => {
		expect(detectImageLabelDivergence(null, null)).toEqual([]);
		expect(detectImageLabelDivergence(undefined, undefined)).toEqual([]);
		expect(detectImageLabelDivergence({}, {})).toEqual([]);
	});

	test('returns differing keys', () => {
		const result = detectImageLabelDivergence(
			{ 'com.example.policy': 'strict', shared: 'same' },
			{ 'com.example.policy': 'permissive', shared: 'same' }
		);
		expect(result).toEqual(['com.example.policy']);
	});

	test('does NOT report keys present in only one side', () => {
		const result = detectImageLabelDivergence(
			{ 'user.only': 'foo' },
			{ 'image.only': 'bar' }
		);
		expect(result).toEqual([]);
	});

	test('dockhand.update opt-out: user="false" vs image="true"', () => {
		// The exact regression we worried about: user disables auto-update
		// via label; image bakes the opposite default.
		expect(
			detectImageLabelDivergence({ 'dockhand.update': 'false' }, { 'dockhand.update': 'true' })
		).toEqual(['dockhand.update']);
	});

	test('handles empty values', () => {
		expect(
			detectImageLabelDivergence({ EMPTY: '' }, { EMPTY: 'set' })
		).toEqual(['EMPTY']);
		expect(
			detectImageLabelDivergence({ EMPTY: '' }, { EMPTY: '' })
		).toEqual([]);
	});
});
