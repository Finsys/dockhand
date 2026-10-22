<script lang="ts">
	import { page } from '$app/stores';
	import { m } from '$lib/paraglide/messages.js';

	let currentPath = $derived($page.url.pathname);

	function isActive(path: string): boolean {
		return currentPath === path;
	}
</script>

<nav class="flex-1 overflow-y-auto py-2">
	<ul class="space-y-0.5 px-2">
		<li>
			<a
				href="/"
				class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all duration-150 {isActive('/')
					? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 font-medium'
					: 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-200'}"
			>
				<svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path
						d="M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z"
						fill="currentColor"
					/>
				</svg>
				<span>{m.nav_dashboard()}</span>
			</a>
		</li>
		<li>
			<a
				href="/containers"
				class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all duration-150 {isActive(
					'/containers'
				)
					? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 font-medium'
					: 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-200'}"
			>
				<svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<rect x="3" y="3" width="7" height="7" rx="1" fill="currentColor" />
					<rect x="3" y="13" width="7" height="7" rx="1" fill="currentColor" />
					<rect x="13" y="3" width="7" height="7" rx="1" fill="currentColor" />
					<rect x="13" y="13" width="7" height="7" rx="1" fill="currentColor" />
				</svg>
				<span>{m.nav_containers()}</span>
			</a>
		</li>
		<li>
			<a
				href="/stacks"
				class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all duration-150 {isActive('/stacks')
					? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 font-medium'
					: 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-200'}"
			>
				<svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path
						d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5z"
						fill="currentColor"
						opacity="0.3"
					/>
					<path
						d="M12 2L2 7v10c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V7l-10-5zm0 2.18l7.5 3.75v8.32c0 4.35-3 8.44-7.5 9.57-4.5-1.13-7.5-5.22-7.5-9.57V7.93L12 4.18z"
						fill="currentColor"
					/>
					<path d="M7 12l3 3 6-6" stroke="currentColor" stroke-width="2" fill="none" />
				</svg>
				<span>{m.navselector_compose_stacks()}</span>
			</a>
		</li>
		<li>
			<a
				href="/images"
				class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all duration-150 {isActive('/images')
					? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 font-medium'
					: 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-200'}"
			>
				<svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none" />
					<circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.3" />
					<path
						d="M12 3v2m0 14v2M3 12h2m14 0h2m-3.05-7.05l1.42-1.42M5.63 18.37l1.42-1.42m11.9 0l1.42 1.42M5.63 5.63l1.42 1.42"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
					/>
				</svg>
				<span>{m.nav_images()}</span>
			</a>
		</li>
		<li>
			<a
				href="/logs"
				class="flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-all duration-150 {isActive('/logs')
					? 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400 font-medium'
					: 'text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800/50 dark:hover:text-gray-200'}"
			>
				<svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<rect x="3" y="4" width="18" height="2" rx="1" fill="currentColor" opacity="0.5" />
					<rect x="3" y="8" width="18" height="2" rx="1" fill="currentColor" />
					<rect x="3" y="12" width="14" height="2" rx="1" fill="currentColor" opacity="0.5" />
					<rect x="3" y="16" width="16" height="2" rx="1" fill="currentColor" />
				</svg>
				<span>{m.nav_logs()}</span>
			</a>
		</li>
	</ul>
</nav>
