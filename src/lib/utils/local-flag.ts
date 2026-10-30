/** A per-browser on/off setting. Storage can be missing or refuse (private mode); then it is off and not kept. */
export function loadLocalFlag(key: string): boolean {
	if (typeof window === 'undefined') return false;
	try {
		return localStorage.getItem(key) === '1';
	} catch {
		return false;
	}
}

export function saveLocalFlag(key: string, on: boolean): void {
	if (typeof window === 'undefined') return;
	try {
		localStorage.setItem(key, on ? '1' : '0');
	} catch {
		// Not kept; the toggle still works for this page.
	}
}
