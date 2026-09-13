/**
 * Persist a stack icon to the name-based /api/stacks/[name]/icon endpoint. Shared by
 * StackModal and GitStackModal so the DELETE/upload/set contract lives in one place. The
 * caller builds `target` (it owns env resolution and create-vs-edit gating); `value` is
 * the picker output: '' -> clear (DELETE), 'upload:<dataUrl>' -> custom upload, else a
 * lucide/selfhst ref. Returns the new icon on success, null after a clear, and undefined
 * when a POST failed (so the caller leaves the current icon untouched).
 */
export async function persistStackIcon(target: string, value: string): Promise<string | null | undefined> {
	if (!value) {
		await fetch(target, { method: 'DELETE' });
		return null;
	}
	const body = value.startsWith('upload:')
		? { image: value.slice('upload:'.length) }
		: { icon: value };
	const res = await fetch(target, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body)
	});
	return res.ok ? (await res.json()).icon : undefined;
}
