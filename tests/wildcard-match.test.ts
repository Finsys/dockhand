import { describe, test, expect } from 'bun:test';
import { globMatches, searchTextMatcher, initialWildcard, stackMatchesSearch } from '../src/lib/utils/wildcard-match';
import { containerMatchesSearch } from '../src/lib/utils/container-search-core';

const glob = (pattern: string, text: string) => globMatches(pattern, text);

describe('globMatches', () => {
	// The issue's naming scheme: <service>_<role>_<env>.
	test('* in the middle picks one service in one environment', () => {
		expect(glob('api_*_prod', 'api_web_prod')).toBe(true);
		expect(glob('api_*_prod', 'api_worker_prod')).toBe(true);
		expect(glob('api_*_prod', 'api_worker_staging')).toBe(false);
		expect(glob('api_*_prod', 'api_web_prod_old')).toBe(false);
		expect(glob('api_*_prod', 'old_api_web_prod')).toBe(false);
	});

	test('* also matches nothing', () => {
		expect(glob('api_*_prod', 'api__prod')).toBe(true);
		expect(glob('*-cache', '-cache')).toBe(true);
	});

	test('? is exactly one character', () => {
		expect(glob('web-?', 'web-1')).toBe(true);
		expect(glob('web-?', 'web-')).toBe(false);
		expect(glob('web-?', 'web-12')).toBe(false);
	});

	test('the pattern covers the whole text, case-insensitively', () => {
		expect(glob('*-cache', 'redis-cache')).toBe(true);
		expect(glob('*-cache', 'redis-cache-old')).toBe(false);
		expect(glob('API_*', 'api_web_prod')).toBe(true);
		expect(glob('api_*', 'API_Web_Prod')).toBe(true);
		expect(glob('nginx', 'nginx')).toBe(true);
		expect(glob('nginx', 'my-nginx')).toBe(false);
	});

	test('regex characters are literal', () => {
		expect(glob('nginx:1.27', 'nginx:1.27')).toBe(true);
		expect(glob('nginx:1.27', 'nginx:1x27')).toBe(false);
		expect(glob('a+b(c)[d]{2}|e$^\\', 'a+b(c)[d]{2}|e$^\\')).toBe(true);
		expect(glob('a.b', 'axb')).toBe(false);
	});

	test('a newline in the text is still covered by *', () => {
		expect(glob('a*b', 'a\nb')).toBe(true);
	});

	test('runs of stars, a star at either end, and an empty pattern', () => {
		expect(glob('**', '')).toBe(true);
		expect(glob('', '')).toBe(true);
		expect(glob('', 'x')).toBe(false);
		expect(glob('a**b', 'axyzb')).toBe(true);
		expect(glob('*a*', 'bab')).toBe(true);
		expect(glob('*a*', 'bbb')).toBe(false);
	});

	test('? is one character even outside the basic plane', () => {
		expect(glob('db-?', 'db-\u{1F600}')).toBe(true);
	});

	test('a pattern with many stars against a long text that does not match stays fast', () => {
		// A backtracking regex takes seconds here (exponential in the stars); the
		// filter runs on every keystroke for every name and label.
		const started = performance.now();
		expect(glob('a*'.repeat(12) + 'b', 'a'.repeat(2000))).toBe(false);
		expect(glob('*a*a*a*a*a*a*b', 'a'.repeat(5000))).toBe(false);
		expect(performance.now() - started).toBeLessThan(500);
	});
});

describe('initialWildcard', () => {
	test('a search in the URL brings its own mode', () => {
		expect(initialWildcard(new URLSearchParams('search=api_*&wildcard=1'), true, false)).toBe(true);
		expect(initialWildcard(new URLSearchParams('search=nginx:latest'), true, true)).toBe(false);
	});

	test('without a search the stored choice applies', () => {
		expect(initialWildcard(new URLSearchParams(''), false, true)).toBe(true);
		expect(initialWildcard(new URLSearchParams(''), false, false)).toBe(false);
	});
});

describe('stackMatchesSearch', () => {
	test('plain mode is the old substring test on name or status, untrimmed', () => {
		expect(stackMatchesSearch('immich', 'running', 'mmi', false)).toBe(true);
		expect(stackMatchesSearch('immich', 'running', 'RUN', false)).toBe(true);
		expect(stackMatchesSearch('immich', 'running', 'mmi ', false)).toBe(false);
		expect(stackMatchesSearch('immich', 'running', '', false)).toBe(true);
	});

	test('wildcard mode matches a whole name or status, trimmed', () => {
		expect(stackMatchesSearch('dbl2', 'exited', 'dbl?', true)).toBe(true);
		expect(stackMatchesSearch('dbl', 'exited', 'dbl?', true)).toBe(false);
		expect(stackMatchesSearch('immich', 'running', 'run*', true)).toBe(true);
		expect(stackMatchesSearch('immich', 'running', 'imm', true)).toBe(false);
		expect(stackMatchesSearch('immich', 'running', ' immich ', true)).toBe(true);
		expect(stackMatchesSearch('immich', 'running', '  ', true)).toBe(true);
	});
});

describe('searchTextMatcher', () => {
	test('a plain query stays a case-insensitive substring', () => {
		const m = searchTextMatcher('API', false);
		expect(m('my_api_web')).toBe(true);
		expect(m('web')).toBe(false);
		expect(m(undefined)).toBe(false);
	});

	test('in plain mode * and ? are ordinary characters', () => {
		expect(searchTextMatcher('api_*_prod', false)('api_web_prod')).toBe(false);
		expect(searchTextMatcher('web-?', false)('web-?')).toBe(true);
	});
});

describe('containerMatchesSearch in wildcard mode', () => {
	const c = {
		name: 'api_web_prod',
		image: 'registry.example.com/api:1.4',
		labels: { 'com.docker.compose.project': 'shop', tier: 'frontend' }
	};

	test('matches the name, the image and a label key or value', () => {
		expect(containerMatchesSearch(c, 'api_*_prod', true)).toBe(true);
		expect(containerMatchesSearch(c, '*/api:1.?', true)).toBe(true);
		expect(containerMatchesSearch(c, 'front*', true)).toBe(true);
		expect(containerMatchesSearch(c, 'com.docker.*', true)).toBe(true);
	});

	test('a part of a field no longer matches on its own', () => {
		expect(containerMatchesSearch(c, 'web', true)).toBe(false);
		expect(containerMatchesSearch(c, 'web', false)).toBe(true);
		expect(containerMatchesSearch(c, 'api_*_staging', true)).toBe(false);
	});

	test('a label: query stays the label filter', () => {
		expect(containerMatchesSearch(c, 'label:tier=frontend', true)).toBe(true);
		expect(containerMatchesSearch(c, 'label:tier=front*', true)).toBe(false);
	});

	test('an empty query matches everything', () => {
		expect(containerMatchesSearch(c, '  ', true)).toBe(true);
	});
});

// The pages load the database through their API calls, so the wiring is pinned at the source.
describe('the search boxes use the wildcard toggle', () => {
	const { readFileSync } = require('node:fs') as typeof import('node:fs');
	const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

	test('containers: the toggle is bound, kept per browser and used by the filter', () => {
		const src = read('../src/routes/containers/+page.svelte');
		expect(src).toContain('bind:wildcard={searchWildcard}');
		expect(src).toContain("const SEARCH_WILDCARD_KEY = 'dockhand-containers-search-wildcard';");
		expect(src).toContain('onwildcardchange={(on) => saveLocalFlag(SEARCH_WILDCARD_KEY, on)}');
		expect(src).toContain('initialWildcard($page.url.searchParams, !!initialSearch, loadLocalFlag(SEARCH_WILDCARD_KEY))');
		expect(src).toContain("if (q && searchWildcard) url.searchParams.set('wildcard', '1');");
		expect(src).toContain('containerMatchesSearch(c, searchQuery, searchWildcard)');
		expect(src).not.toContain('$effect(() => saveLocalFlag');
	});

	test('stacks: the toggle is bound, kept per browser and used by the filter', () => {
		const src = read('../src/routes/stacks/+page.svelte');
		expect(src).toContain('bind:wildcard={searchWildcard}');
		expect(src).toContain("const SEARCH_WILDCARD_KEY = 'dockhand-stacks-search-wildcard';");
		expect(src).toContain('onwildcardchange={(on) => saveLocalFlag(SEARCH_WILDCARD_KEY, on)}');
		expect(src).toContain('initialWildcard($page.url.searchParams, !!initialSearch, loadLocalFlag(SEARCH_WILDCARD_KEY))');
		expect(src).toContain("if (q && searchWildcard) url.searchParams.set('wildcard', '1');");
		expect(src).toContain('stackMatchesSearch(stack.name, getDisplayStatus(stack), searchQuery, searchWildcard)');
		expect(src).toContain('wildcardHint={m.ui_search_wildcard_stacks()}');
		expect(src).not.toContain('$effect(() => saveLocalFlag');
	});
});
