import { describe, test, expect } from 'bun:test';
import { fileBrowserStartPath } from '../src/lib/utils/file-browser-start';

describe('fileBrowserStartPath', () => {
	test('uses an absolute WorkingDir', () => {
		expect(fileBrowserStartPath('/usr/share/nginx/html')).toBe('/usr/share/nginx/html');
	});

	test('empty or missing WorkingDir opens root', () => {
		expect(fileBrowserStartPath('')).toBe('/');
		expect(fileBrowserStartPath(undefined)).toBe('/');
		expect(fileBrowserStartPath(null)).toBe('/');
		expect(fileBrowserStartPath('   ')).toBe('/');
	});

	test('relative WorkingDir opens root', () => {
		expect(fileBrowserStartPath('app')).toBe('/');
		expect(fileBrowserStartPath('./app')).toBe('/');
	});

	test('normalizes trailing and duplicate slashes', () => {
		expect(fileBrowserStartPath('/app/')).toBe('/app');
		expect(fileBrowserStartPath('//app//data/')).toBe('/app/data');
		expect(fileBrowserStartPath('/app/./data')).toBe('/app/data');
		expect(fileBrowserStartPath('/')).toBe('/');
	});

	test('parent segments fall back to root', () => {
		expect(fileBrowserStartPath('/app/../etc')).toBe('/');
	});
});
