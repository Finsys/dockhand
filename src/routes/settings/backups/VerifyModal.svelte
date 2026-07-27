<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import * as Select from '$lib/components/ui/select';
	import { Button } from '$lib/components/ui/button';
	import { ShieldCheck, Loader2, CheckCircle, XCircle } from 'lucide-svelte';
	import { watchJob } from '$lib/utils/sse-fetch';

	interface Props {
		open: boolean;
		destinationId: number;
		destinationName: string;
	}

	let { open = $bindable(), destinationId, destinationName }: Props = $props();

	let dataSubset = $state('5%');
	let running = $state(false);
	let status = $state<'idle' | 'running' | 'success' | 'error'>('idle');
	let logs = $state<string[]>([]);
	let error = $state('');

	$effect(() => {
		if (open) {
			status = 'idle';
			running = false;
			logs = [];
			error = '';
			dataSubset = '5%';
		}
	});

	async function runVerify() {
		running = true;
		status = 'running';
		logs = [`Starting verification (reading ${dataSubset} of data)...`];
		error = '';

		try {
			const res = await fetch(`/api/backup/destinations/${destinationId}/verify`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ dataSubset })
			});
			const data = await res.json();

			if (data.jobId) {
				await watchJob(data.jobId, (line) => {
					if (line.event === 'progress' && line.data?.message) {
						logs = [...logs, line.data.message];
					}
				});
				status = 'success';
				logs = [...logs, 'Verification passed'];
			} else if (data.error) {
				status = 'error';
				error = data.error;
			} else {
				status = data.success ? 'success' : 'error';
				if (!data.success) error = data.error || 'Unknown error';
			}
		} catch (err: any) {
			status = 'error';
			error = err.message || 'Verification failed';
		} finally {
			running = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-lg max-h-[70vh] flex flex-col">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ShieldCheck class="w-4 h-4" />Verify backup integrity
			</Dialog.Title>
			<Dialog.Description>{destinationName}</Dialog.Description>
		</Dialog.Header>

		{#if status === 'idle'}
			<div class="space-y-3 py-2">
				<p class="text-xs text-muted-foreground">
					Reads a random subset of data packs from the repository and verifies they are intact and readable. Larger subsets take longer but provide more thorough verification.
				</p>
				<div class="flex items-center gap-3">
					<span class="text-xs text-muted-foreground shrink-0">Data to verify:</span>
					<Select.Root type="single" value={dataSubset} onValueChange={(v) => dataSubset = v}>
						<Select.Trigger class="h-8 w-28 text-xs">{dataSubset}</Select.Trigger>
						<Select.Content>
							<Select.Item value="5%">5% (quick)</Select.Item>
							<Select.Item value="10%">10%</Select.Item>
							<Select.Item value="25%">25%</Select.Item>
							<Select.Item value="50%">50%</Select.Item>
							<Select.Item value="100%">100% (full)</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>
			<div class="flex justify-end gap-2 pt-2">
				<Button variant="outline" size="sm" onclick={() => open = false}>Cancel</Button>
				<Button size="sm" onclick={runVerify}>
					<ShieldCheck class="w-3.5 h-3.5 mr-1.5" />Verify
				</Button>
			</div>
		{:else}
			<div class="flex-1 overflow-y-auto border rounded bg-muted/30 p-2 font-mono text-[11px] space-y-0.5 min-h-[200px]">
				{#each logs as line}
					<div class="text-muted-foreground">{line}</div>
				{/each}
				{#if status === 'running'}
					<div class="flex items-center gap-1.5 text-primary">
						<Loader2 class="w-3 h-3 animate-spin" />Running...
					</div>
				{/if}
				{#if status === 'success'}
					<div class="flex items-center gap-1.5 text-green-500 font-medium mt-2">
						<CheckCircle class="w-3.5 h-3.5" />Verification passed
					</div>
				{/if}
				{#if status === 'error'}
					<div class="flex items-center gap-1.5 text-destructive font-medium mt-2">
						<XCircle class="w-3.5 h-3.5" />{error}
					</div>
				{/if}
			</div>
			<div class="flex justify-end pt-2">
				<Button variant="outline" size="sm" onclick={() => open = false}>Close</Button>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>
