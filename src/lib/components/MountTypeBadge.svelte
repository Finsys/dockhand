<script lang="ts">
	/**
	 * A mount-type indicator: a colored icon + uppercase pill for `bind` vs `volume`.
	 * Shared so every place that lists mounts (backup dialog VolumePicker, snapshot
	 * Browse metadata — Volumes & binds and Mounts) renders them identically:
	 * amber Folder + "bind" for binds, sky HardDrive + "vol" for named volumes.
	 */
	import { Folder, HardDrive } from 'lucide-svelte';

	// `sm` matches the denser VolumePicker rows (smaller icon, fixed-width pill);
	// the default matches the roomier snapshot-metadata rows.
	let { type, size = 'default' }: { type?: string | null; size?: 'default' | 'sm' } = $props();
	const isBind = $derived(type === 'bind');
	const iconCls = $derived(size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4');
	const pillCls = $derived(size === 'sm' ? 'w-12' : '');
</script>

{#if isBind}
	<Folder class="{iconCls} text-amber-500 shrink-0" />
	<span class="shrink-0 {pillCls} text-center rounded-full px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400">bind</span>
{:else}
	<HardDrive class="{iconCls} text-sky-500 shrink-0" />
	<span class="shrink-0 {pillCls} text-center rounded-full px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wide bg-sky-500/15 text-sky-600 dark:text-sky-400">vol</span>
{/if}
