import { writable, get } from 'svelte/store';
import { browser } from '$app/environment';

const store = writable<Record<string, string>>({});
let loaded = false;

async function load() {
	if (!browser || loaded) return;
	loaded = true;
	try {
		const res = await fetch('/api/labels');
		if (res.ok) {
			const data = await res.json();
			store.set(data.colors || {});
		}
	} catch {
		// ignore
	}
}

export const labelColorOverrides = {
	subscribe: store.subscribe,
	load,
	reload: async () => {
		loaded = false;
		await load();
	}
};
