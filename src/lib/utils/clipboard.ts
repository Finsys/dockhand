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

	// Fallback: hidden textarea + execCommand for HTTP (insecure) contexts, where
	// navigator.clipboard is unavailable. The textarea must live INSIDE the current
	// focus-trap (e.g. a shadcn/bits-ui Dialog): appended to document.body it sits
	// outside the trap, which yanks focus back to the dialog before execCommand runs,
	// so the copy silently fails and pastes stale clipboard content (#1488). Mount it
	// in the open dialog when there is one, else document.body.
	try {
		const openDialog = document.querySelector<HTMLElement>('[role="dialog"]');
		const host = openDialog ?? document.body;
		const active = document.activeElement as HTMLElement | null;

		const textarea = document.createElement('textarea');
		textarea.value = text;
		textarea.setAttribute('readonly', '');
		textarea.style.position = 'fixed';
		textarea.style.left = '-9999px';
		textarea.style.top = '-9999px';
		textarea.style.opacity = '0';
		host.appendChild(textarea);
		textarea.focus();
		textarea.select();
		textarea.setSelectionRange(0, textarea.value.length);
		const ok = document.execCommand('copy');
		host.removeChild(textarea);
		// Restore focus to whatever the user had (keeps the dialog's focus-trap happy).
		active?.focus?.();
		if (ok) return true;
	} catch {
		/* fall through */
	}

	return false;
}
