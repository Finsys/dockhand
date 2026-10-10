<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { Sparkles, Bug, Zap, CheckCircle, ScrollText } from 'lucide-svelte';
	import { compareVersions } from '$lib/utils/version';
	import { releasedEntries } from '$lib/utils/changelog-filter';
	import ChangelogText from '$lib/components/ChangelogText.svelte';
	import { m } from '$lib/paraglide/messages.js';

	interface ChangelogEntry {
		version: string;
		date: string;
		changes: Array<{ type: string; text: string }>;
		imageTag?: string;
		comingSoon?: boolean;
	}

	interface Props {
		open: boolean;
		version: string;
		lastSeenVersion: string | null;
		changelog: ChangelogEntry[];
		onDismiss: () => void;
	}

	let { open = $bindable(), version, changelog, lastSeenVersion, onDismiss }: Props = $props();

	// Versions newer than lastSeenVersion, 3 most recent. Coming-soon (unreleased)
	// entries are excluded: the user is on a released build, so an unreleased version
	// must never appear as something they "missed".
	const missedReleases = $derived(
		releasedEntries(changelog)
			.filter((r) => {
				if (!lastSeenVersion) return true; // Show all if first time
				return compareVersions(r.version, lastSeenVersion.replace(/^v/, '')) > 0;
			})
			.slice(0, 3)
	);

	function getChangeIcon(type: string) {
		switch (type) {
			case 'feature':
				return { icon: Sparkles, class: 'text-green-500' };
			case 'fix':
				return { icon: Bug, class: 'text-amber-500' };
			case 'improvement':
				return { icon: Zap, class: 'text-green-500' };
			default:
				return { icon: CheckCircle, class: 'text-muted-foreground' };
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-w-3xl">
		<Dialog.Header>
			<Dialog.Title class="flex items-center gap-2">
				<ScrollText class="w-5 h-5 text-muted-foreground" />
				{m.whatsnew_title({ version })}
			</Dialog.Title>
		</Dialog.Header>

		<div class="py-4 max-h-[60vh] overflow-y-auto space-y-6">
			{#each missedReleases as release}
				<div>
					<h3 class="font-semibold text-sm mb-2 flex items-center gap-2">
						<span>v{release.version}</span>
						<span class="text-muted-foreground font-normal">({release.date})</span>
					</h3>
					<div class="space-y-1.5 ml-1">
						{#each [...release.changes].sort((a, b) => a.type === b.type ? 0 : a.type === 'feature' ? -1 : 1) as change}
							{@const { icon: Icon, class: iconClass } = getChangeIcon(change.type)}
							<div class="flex items-start gap-2">
								<Icon class="w-4 h-4 mt-0.5 shrink-0 {iconClass}" />
								<ChangelogText text={change.text} />
							</div>
						{/each}
					</div>
				</div>
			{/each}
		</div>

		<Dialog.Footer>
			<Button onclick={onDismiss}>{m.whatsnew_got_it()}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
