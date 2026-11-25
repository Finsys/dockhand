<script lang="ts">
	import * as Popover from '$lib/components/ui/popover';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Icon, RefreshCw, Info, Check, XCircle } from 'lucide-svelte';
	import { broom } from '@lucide/lab';
	import { appendEnvParam } from '$lib/stores/environment';
	import { formatBytes } from '$lib/utils/format';
	import { readJobResponse } from '$lib/utils/sse-fetch';
	import { toast } from 'svelte-sonner';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		envId?: number | null;
		onComplete?: () => void;
	}

	let { envId, onComplete }: Props = $props();

	let open = $state(false);
	let mode = $state<'dangling' | 'all'>('dangling');
	let until = $state('');
	// reserved space entered in GiB for a friendly unit; converted to bytes on submit.
	let reservedGiB = $state('');
	let status = $state<'idle' | 'pruning' | 'success' | 'error'>('idle');

	const modeLabel = $derived(
		mode === 'all' ? m.images_build_cache_mode_all() : m.images_build_cache_mode_dangling()
	);

	// On open, seed the fields from this environment's scheduled-job settings so a manual
	// prune starts from whatever the operator already configured for the schedule. Only the
	// parameter values are inherited, never the enabled flag or the cron. Best-effort: a
	// failed or denied read just leaves the defaults.
	$effect(() => {
		if (!open || envId == null) return;
		(async () => {
			try {
				const res = await fetch(`/api/environments/${envId}/build-cache-prune`);
				if (!res.ok) return;
				const data = await res.json();
				const s = data?.settings;
				if (!s) return;
				mode = s.pruneMode === 'all' ? 'all' : 'dangling';
				until = typeof s.until === 'string' ? s.until : '';
				reservedGiB = typeof s.reservedSpace === 'number' && s.reservedSpace > 0
					? String(+(s.reservedSpace / 1024 ** 3).toFixed(2))
					: '';
			} catch {
				// keep defaults
			}
		})();
	});

	async function runPrune() {
		status = 'pruning';
		try {
			const params = new URLSearchParams();
			if (mode === 'all') params.set('all', 'true');
			if (until.trim() !== '') params.set('until', until.trim());
			const gib = parseFloat(reservedGiB);
			if (Number.isFinite(gib) && gib > 0) {
				params.set('reserved-space', String(Math.floor(gib * 1024 ** 3)));
			}
			const base = `/api/prune/build-cache?${params.toString()}`;
			const response = await fetch(appendEnvParam(base, envId), { method: 'POST' });
			const data = await readJobResponse(response);
			if (data.success) {
				const reclaimed: number | undefined = data.result?.SpaceReclaimed;
				status = 'success';
				toast.success(
					reclaimed === undefined || reclaimed === 0
						? m.images_build_cache_toast_nothing()
						: m.images_build_cache_toast_done({ size: formatBytes(reclaimed) })
				);
				open = false;
				onComplete?.();
			} else {
				status = 'error';
				toast.error(data.error || m.images_build_cache_toast_failed());
			}
		} catch (error) {
			status = 'error';
			toast.error(m.images_build_cache_toast_failed());
		}
		if (status !== 'success') setTimeout(() => { status = 'idle'; }, 3000);
		else status = 'idle';
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger
		class="inline-flex items-center gap-1.5 h-8 px-3 rounded-md text-sm bg-background shadow-xs border hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50"
		title={m.images_build_cache_hint()}
	>
		{#if status === 'pruning'}
			<RefreshCw class="w-3.5 h-3.5 animate-spin" />
		{:else if status === 'success'}
			<Check class="w-3.5 h-3.5 text-green-600" />
		{:else if status === 'error'}
			<XCircle class="w-3.5 h-3.5 text-destructive" />
		{:else}
			<Icon iconNode={broom} class="w-3.5 h-3.5 text-violet-600" />
		{/if}
		{m.images_build_cache_button()}
	</Popover.Trigger>
	<Popover.Content class="w-80 p-0" align="end" sideOffset={5}>
		<div class="px-3 py-2.5 border-b bg-muted/50">
			<div class="flex items-center gap-2">
				<Icon iconNode={broom} class="w-3.5 h-3.5 text-violet-600" />
				<span class="text-sm font-medium">{m.images_build_cache_title()}</span>
			</div>
			<p class="text-xs text-muted-foreground mt-1">{m.images_build_cache_desc()}</p>
		</div>

		<div class="p-3 space-y-3">
			<div class="space-y-1.5">
				<Label class="text-xs">{m.images_build_cache_mode_label()}</Label>
				<Select.Root type="single" bind:value={mode}>
					<Select.Trigger class="w-full h-8 text-sm">{modeLabel}</Select.Trigger>
					<Select.Content>
						<Select.Item value="dangling">{m.images_build_cache_mode_dangling()}</Select.Item>
						<Select.Item value="all">{m.images_build_cache_mode_all()}</Select.Item>
					</Select.Content>
				</Select.Root>
			</div>

			<div class="grid grid-cols-2 gap-2">
				<div class="space-y-1.5">
					<Label for="bc-until" class="text-xs">{m.images_build_cache_until_label()}</Label>
					<Input id="bc-until" class="h-8 text-sm" bind:value={until} placeholder="336h" />
				</div>
				<div class="space-y-1.5">
					<Label for="bc-reserved" class="text-xs">{m.images_build_cache_reserved_label()}</Label>
					<Input id="bc-reserved" class="h-8 text-sm" type="number" min="0" step="0.5" bind:value={reservedGiB} placeholder="0" />
				</div>
			</div>
			<p class="text-xs text-muted-foreground">{m.images_build_cache_fields_hint()}</p>

			{#if mode === 'all'}
				<div class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-400">
					<Info class="w-3.5 h-3.5 mt-0.5 shrink-0" />
					<span>{m.images_build_cache_all_warning()}</span>
				</div>
			{/if}

			<div class="flex justify-end gap-2 pt-1">
				<Button variant="outline" size="sm" onclick={() => (open = false)} disabled={status === 'pruning'}>
					{m.images_build_cache_cancel()}
				</Button>
				<Button size="sm" onclick={runPrune} disabled={status === 'pruning'}>
					{#if status === 'pruning'}
						<RefreshCw class="w-3.5 h-3.5 mr-1.5 animate-spin" />
					{:else}
						<Icon iconNode={broom} class="w-3.5 h-3.5 mr-1.5" />
					{/if}
					{m.images_build_cache_submit()}
				</Button>
			</div>
		</div>
	</Popover.Content>
</Popover.Root>
