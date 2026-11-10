<script lang="ts">
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import * as Select from '$lib/components/ui/select';
	import { Shell, User, Loader2, Trash2 } from 'lucide-svelte';
	import {
		detectShells,
		getBestShell,
		hasAvailableShell,
		USER_OPTIONS,
		getSavedUser,
		saveUserForContainer,
		getCustomUsers,
		removeCustomUser,
		userForContainerSwitch,
		type ShellDetectionResult
	} from '$lib/utils/shell-detection';
	import { m } from '$lib/paraglide/messages.js';

	interface Props {
		containerId: string;
		envId: number | null;
		shell: string;
		user: string;
		/** Hidden in attach mode (shell/user do not apply). */
		mode?: string;
		/** Fired after a shell or user change is committed, so the host can reconnect. */
		onChange?: () => void;
		/** Detection state surfaced for a host that renders its own empty states. */
		detecting?: boolean;
		anyShellAvailable?: boolean;
	}
	let {
		containerId,
		envId,
		shell = $bindable(),
		user = $bindable(),
		mode = 'exec',
		onChange,
		detecting = $bindable(false),
		anyShellAvailable: anyShellAvailableOut = $bindable(true)
	}: Props = $props();

	let shellDetection = $state<ShellDetectionResult | null>(null);
	let detectingShells = $state(false);
	$effect(() => {
		detecting = detectingShells;
	});
	$effect(() => {
		anyShellAvailableOut = anyShellAvailable;
	});
	let customUserInput = $state('');
	let customUsers = $state<string[]>([]);

	const selectedShellAvailable = $derived(
		!shellDetection || shellDetection.shells.includes(shell)
	);
	const anyShellAvailable = $derived(!shellDetection || hasAvailableShell(shellDetection));

	// Detect shells whenever the container changes. Restores the saved user and the
	// best available shell for that container; a failed detection keeps the defaults.
	let detectedFor: string | null = null;
	$effect(() => {
		const id = containerId;
		if (!id || id === detectedFor) return;
		detectedFor = id;
		customUsers = getCustomUsers();
		// A container with a saved user restores it; one without falls back to root, so
		// the previous container's user never carries over (the picker instance and its
		// bound user outlive a container switch on the terminal page).
		const next = userForContainerSwitch(getSavedUser(id), user);
		if (next !== user) user = next;
		detectingShells = true;
		shellDetection = null;
		detectShells(id, envId)
			.then((result) => {
				shellDetection = result;
				const best = getBestShell(result, shell);
				if (best && best !== shell) shell = best;
			})
			.catch(() => {
				// Leave the defaults; the terminal still connects with them.
			})
			.finally(() => {
				detectingShells = false;
			});
	});

	function shellLabel(path: string): string {
		return (
			shellDetection?.allShells.find((o) => o.path === path)?.label ||
			(path === '/bin/bash'
				? 'Bash'
				: path === '/bin/sh'
					? 'Shell (sh)'
					: path === '/bin/zsh'
						? 'Zsh'
						: path === '/bin/ash'
							? 'Ash (Alpine)'
							: m.containers_list_select())
		);
	}

	function onUserSelectChange(value: string) {
		user = value;
		saveUserForContainer(containerId, value);
		customUsers = getCustomUsers();
		onChange?.();
	}

	function onCustomUserKeydown(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Enter' && customUserInput.trim()) {
			const newUser = customUserInput.trim();
			user = newUser;
			saveUserForContainer(containerId, newUser);
			customUsers = getCustomUsers();
			customUserInput = '';
			onChange?.();
		}
	}
</script>

{#if mode === 'exec'}
	<!-- Shell selector -->
	<div class="flex items-center gap-2">
		<Label class="text-sm text-muted-foreground">{m.terminal_shell_label()}</Label>
		{#if detectingShells}
			<div class="h-9 w-36 flex items-center justify-center border rounded-md bg-muted/50">
				<Loader2 class="w-4 h-4 animate-spin text-muted-foreground" />
			</div>
		{:else}
			<Select.Root type="single" bind:value={shell} onValueChange={() => onChange?.()}>
				<Select.Trigger class="h-9 w-44" disabled={!anyShellAvailable}>
					<Shell class="w-4 h-4 mr-2 text-muted-foreground" />
					<span class={!selectedShellAvailable ? 'text-muted-foreground line-through' : ''}>
						{shellLabel(shell)}
					</span>
				</Select.Trigger>
				<Select.Content>
					{#if shellDetection}
						{#each shellDetection.allShells as option}
							<Select.Item value={option.path} label={option.label} disabled={!option.available}>
								<Shell class="w-4 h-4 mr-2 {option.available ? 'text-green-500' : 'text-muted-foreground/40'}" />
								<span class={option.available ? 'text-foreground' : 'text-muted-foreground/60'}>
									{option.label}
									{#if !option.available}
										<span class="text-xs ml-1">{m.containers_terminal_unavailable()}</span>
									{/if}
								</span>
							</Select.Item>
						{/each}
					{:else}
						<Select.Item value="/bin/bash" label="Bash">
							<Shell class="w-4 h-4 mr-2 text-muted-foreground" />Bash
						</Select.Item>
						<Select.Item value="/bin/sh" label="Shell (sh)">
							<Shell class="w-4 h-4 mr-2 text-muted-foreground" />Shell (sh)
						</Select.Item>
						<Select.Item value="/bin/zsh" label="Zsh">
							<Shell class="w-4 h-4 mr-2 text-muted-foreground" />Zsh
						</Select.Item>
						<Select.Item value="/bin/ash" label="Ash (Alpine)">
							<Shell class="w-4 h-4 mr-2 text-muted-foreground" />Ash (Alpine)
						</Select.Item>
					{/if}
				</Select.Content>
			</Select.Root>
		{/if}
	</div>

	<!-- User selector -->
	<div class="flex items-center gap-2">
		<Label class="text-sm text-muted-foreground">{m.terminal_user_label()}</Label>
		<Select.Root type="single" bind:value={user} onValueChange={onUserSelectChange}>
			<Select.Trigger class="h-9 w-48">
				<User class="w-4 h-4 mr-2 text-muted-foreground" />
				<span>{USER_OPTIONS.find((o) => o.value === user)?.label || user || m.containers_list_select()}</span>
			</Select.Trigger>
			<Select.Content>
				{#each USER_OPTIONS as option}
					<Select.Item value={option.value} label={option.label}>
						<User class="w-4 h-4 mr-2 text-muted-foreground" />
						{option.label}
					</Select.Item>
				{/each}
				{#if customUsers.length > 0}
					<div class="h-px bg-border my-1"></div>
					{#each customUsers as cu}
						<div class="flex items-center group">
							<Select.Item value={cu} label={cu} class="flex-1">
								<User class="w-4 h-4 mr-2 text-muted-foreground" />
								{cu}
							</Select.Item>
							<button
								type="button"
								class="p-1 mr-1 opacity-0 group-hover:opacity-100 hover:text-destructive transition-opacity"
								onclick={(e) => {
									e.stopPropagation();
									e.preventDefault();
									removeCustomUser(cu);
									customUsers = getCustomUsers();
									if (user === cu) onUserSelectChange('root');
								}}
								title={m.containers_list_remove_user()}
							>
								<Trash2 class="w-3 h-3" />
							</button>
						</div>
					{/each}
				{/if}
				<div class="h-px bg-border my-1"></div>
				<!-- svelte-ignore a11y_autofocus -->
				<div class="px-2 py-1">
					<Input
						class="h-7 text-xs"
						placeholder={m.containers_list_add_user_placeholder()}
						bind:value={customUserInput}
						onkeydown={onCustomUserKeydown}
						onclick={(e) => e.stopPropagation()}
					/>
				</div>
			</Select.Content>
		</Select.Root>
	</div>
{/if}
