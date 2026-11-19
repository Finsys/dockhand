import { Github, Gitlab } from 'lucide-svelte';
import type { IconComponent } from '$lib/types';
import GitGenericIcon from '$lib/components/icons/GitGenericIcon.svelte';

/**
 * Pick a forge icon from a repo URL: GitHub and GitLab get their own mark,
 * everything else gets the generic Git logo (mdi-git, not lucide's GitBranch
 * which reads as a branch).
 */
export function forgeIcon(url: string | null | undefined): IconComponent {
	const u = (url || '').toLowerCase();
	if (u.includes('github.com')) return Github as unknown as IconComponent;
	if (u.includes('gitlab.')) return Gitlab as unknown as IconComponent;
	return GitGenericIcon as unknown as IconComponent;
}
