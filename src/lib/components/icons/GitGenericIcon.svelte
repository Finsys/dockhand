<script lang="ts">
	// Generic git-repository glyph (non-GitHub/GitLab forge). The official Git
	// logo (mdi-git) - distinct from lucide's GitBranch, which reads as a branch.
	// currentColor so it inherits text color; `class` mirrors the lucide icon API.
	// Path shared with the log-output icon via GIT_LOGO_PATH (single source).
	import { GIT_LOGO_PATH } from '$lib/icons/git-logo-path';
	let { class: className = '' }: { class?: string } = $props();
</script>

<svg class={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
	<path d={GIT_LOGO_PATH} />
</svg>
