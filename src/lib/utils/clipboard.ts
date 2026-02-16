/**
 * Copy text to clipboard with execCommand fallback for HTTP.
 * Returns true on success, false on failure.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* fall through to execCommand */
		}
	}

	// Fallback: hidden textarea + execCommand for HTTP contexts
	try {
		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		textarea.style.top = '-9999px';
		textarea.style.opacity = '0';
		document.body.appendChild(textarea);
		textarea.focus();
		textarea.select();
		const ok = document.execCommand('copy');
		document.body.removeChild(textarea);
		if (ok) return true;
	} catch {
		/* fall through */
	}

	return false;
}
