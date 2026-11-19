<script lang="ts">
	import { Label } from '$lib/components/ui/label';
	import { TogglePill } from '$lib/components/ui/toggle-pill';
	import CronEditor from '$lib/components/cron-editor.svelte';
	import { Play, Square, Tag, AlertTriangle, Info } from 'lucide-svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		/** Cron expressions; '' means no scheduled start or stop. */
		startAt: string;
		stopAt: string;
		/** 'label' when the container's labels set the times; they are then read-only. */
		source: 'ui' | 'label';
		labelErrors: string[];
		systemContainer: boolean;
		restartPolicy: string;
	}

	let {
		startAt = $bindable(),
		stopAt = $bindable(),
		source,
		labelErrors,
		systemContainer,
		restartPolicy
	}: Props = $props();

	const DEFAULT_START = '0 7 * * *';
	const DEFAULT_STOP = '0 23 * * *';
	const readOnly = $derived(source === 'label');
</script>

{#if systemContainer}
	<div class="rounded-lg border border-blue-500/30 bg-blue-500/5 p-3">
		<div class="flex items-start gap-2 text-xs">
			<Info class="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
			<p class="text-muted-foreground">{m.containers_schedule_system()}</p>
		</div>
	</div>
{:else}
	<div class="space-y-3">
		{#if readOnly}
			<div class="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
				<Tag class="w-3.5 h-3.5 mt-0.5 shrink-0" />
				<p>{m.containers_schedule_from_labels()}</p>
			</div>
		{/if}
		{#if labelErrors.length > 0}
			<div class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
				<AlertTriangle class="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
				<div>
					<p class="text-amber-600 dark:text-amber-400">{m.containers_schedule_label_errors()}</p>
					{#each labelErrors as labelError, i (i)}
						<p class="font-mono text-muted-foreground">{labelError}</p>
					{/each}
				</div>
			</div>
		{/if}

		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
		<div class="space-y-2 min-w-0">
			<div class="flex items-center gap-3">
				<Label class="flex items-center gap-1.5 text-xs font-normal">
					<Play class="w-3.5 h-3.5 text-emerald-500" />{m.containers_schedule_start_at()}
				</Label>
				<TogglePill
					checked={startAt !== ''}
					disabled={readOnly}
					onchange={(on) => (startAt = on ? DEFAULT_START : '')}
					onLabel="ON"
					offLabel="OFF"
				/>
			</div>
			{#if startAt !== ''}
				<CronEditor bind:value={startAt} disabled={readOnly} />
			{/if}
		</div>

		<div class="space-y-2 min-w-0">
			<div class="flex items-center gap-3">
				<Label class="flex items-center gap-1.5 text-xs font-normal">
					<Square class="w-3.5 h-3.5 text-rose-500" />{m.containers_schedule_stop_at()}
				</Label>
				<TogglePill
					checked={stopAt !== ''}
					disabled={readOnly}
					onchange={(on) => (stopAt = on ? DEFAULT_STOP : '')}
					onLabel="ON"
					offLabel="OFF"
				/>
			</div>
			{#if stopAt !== ''}
				<CronEditor bind:value={stopAt} disabled={readOnly} />
			{/if}
		</div>
		</div>

		<p class="text-xs text-muted-foreground">{m.containers_schedule_hint()}</p>

		{#if restartPolicy === 'always' && stopAt !== ''}
			<div class="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
				<AlertTriangle class="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />
				<p class="text-muted-foreground">{m.containers_schedule_restart_always()}</p>
			</div>
		{/if}
	</div>
{/if}
