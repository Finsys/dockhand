<script lang="ts">
	import { onMount } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Table from '$lib/components/ui/table';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import CodeEditor from '$lib/components/CodeEditor.svelte';
	import ConfirmPopover from '$lib/components/ConfirmPopover.svelte';
	import {
		Folder,
		File,
		Link,
		FileQuestion,
		Download,
		Upload,
		RefreshCw,
		ChevronLeft,
		Home,
		Loader2,
		AlertCircle,
		ChevronRight,
		Pencil,
		X,
		Save,
		Sun,
		Moon,
		Eye,
		Lock,
		Trash2,
		FolderPlus,
		FilePlus,
		EyeOff,
		ArrowUpDown,
		ArrowUp,
		ArrowDown,
		Shield,
		TextCursorInput
	} from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { formatDateTime, appSettings } from '$lib/stores/settings';

	interface FileEntry {
		name: string;
		type: 'file' | 'directory' | 'symlink' | 'other';
		size: number;
		permissions: string;
		owner: string;
		group: string;
		modified: string;
		linkTarget?: string;
		readonly?: boolean;
	}

	type BrowserMode = 'container' | 'volume';
	type SortField = 'name' | 'size' | 'modified' | 'type';
	type SortDirection = 'asc' | 'desc';

	interface VolumeUsageInfo {
		containerId: string;
		containerName: string;
		state: string;
	}

	interface Props {
		containerId?: string;
		volumeName?: string;
		envId?: number;
		initialPath?: string;
		canEdit?: boolean;
		onUsageChange?: (usage: VolumeUsageInfo[], isInUse: boolean) => void;
		// File selection mode - when true, clicking a file selects it instead of opening viewer
		selectMode?: boolean;
		// Regex to filter which files can be selected (used with selectMode)
		selectFilter?: RegExp;
		// Callback when a file is selected (in selectMode)
		onFileSelect?: (path: string, name: string) => void;
	}

	let {
		containerId,
		volumeName,
		envId,
		initialPath = '/',
		canEdit = true,
		onUsageChange,
		selectMode = false,
		selectFilter,
		onFileSelect
	}: Props = $props();

	// For volume mode, track whether volume is in use (controls editing ability)
	let volumeIsInUse = $state(false);
	let volumeUsage = $state<VolumeUsageInfo[]>([]);
	// Helper container ID for volume file operations (use container endpoints with this ID)
	let volumeHelperId = $state<string | null>(null);

	// Determine mode based on which prop is provided
	const mode: BrowserMode = $derived(volumeName ? 'volume' : 'container');
	const isVolumeMode = $derived(mode === 'volume');

	// Effective canEdit: for containers, use the prop; for volumes, only allow if not in use
	const effectiveCanEdit = $derived(
		isVolumeMode ? (canEdit && !volumeIsInUse) : canEdit
	);

	// Effective container ID for file operations (use helper container for volume mode)
	const effectiveContainerId = $derived(isVolumeMode ? volumeHelperId : containerId);

	// Volume mount path constant (must match VOLUME_MOUNT_PATH in docker.ts)
	const VOLUME_MOUNT_PATH = '/volume';

	// Transform path for container file operations in volume mode
	// The volume is mounted at /volume in the helper container
	function getContainerPath(path: string): string {
		if (!isVolumeMode) return path;
		return `${VOLUME_MOUNT_PATH}${path.startsWith('/') ? path : '/' + path}`;
	}

	let currentPath = $state('/');
	let entries = $state<FileEntry[]>([]);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let uploading = $state(false);
	let fileInput: HTMLInputElement;
	// Track if this container uses busybox (doesn't support --time-style=iso)
	let useSimpleLs = $state(false);

	// Selection mode state
	let selectedFilePath = $state<string | null>(null);

	// Check if a file matches the select filter (for highlighting)
	function matchesSelectFilter(name: string): boolean {
		if (!selectMode || !selectFilter) return false;
		return selectFilter.test(name);
	}

	// Sort state
	let sortField = $state<SortField>('name');
	let sortDirection = $state<SortDirection>('asc');

	// Hidden files toggle
	let showHiddenFiles = $state(true);

	// Editor/Viewer state
	let editingFile = $state<{ name: string; path: string; content: string } | null>(null);
	let viewingFile = $state<{ name: string; path: string; content: string } | null>(null);
	let editorContent = $state('');
	let loadingFile = $state(false);
	let savingFile = $state(false);
	let editorTheme = $state<'light' | 'dark'>('dark');

	// Create modal state
	let showCreateModal = $state(false);
	let createType = $state<'file' | 'directory'>('file');
	let createName = $state('');
	let creating = $state(false);

	// Rename modal state
	let showRenameModal = $state(false);
	let renameEntry = $state<FileEntry | null>(null);
	let renameName = $state('');
	let renaming = $state(false);

	// Chmod modal state
	let showChmodModal = $state(false);
	let chmodEntry = $state<FileEntry | null>(null);
	let chmodMode = $state('644');
	let chmodRecursive = $state(false);
	let changingPerms = $state(false);

	// Permission checkboxes state (owner, group, others - read, write, execute)
	let permOwnerR = $state(true);
	let permOwnerW = $state(true);
	let permOwnerX = $state(false);
	let permGroupR = $state(true);
	let permGroupW = $state(false);
	let permGroupX = $state(false);
	let permOtherR = $state(true);
	let permOtherW = $state(false);
	let permOtherX = $state(false);

	// Update checkboxes from octal mode
	function octalToCheckboxes(mode: string) {
		const octal = mode.padStart(3, '0').slice(-3);
		const owner = parseInt(octal[0]) || 0;
		const group = parseInt(octal[1]) || 0;
		const other = parseInt(octal[2]) || 0;

		permOwnerR = (owner & 4) !== 0;
		permOwnerW = (owner & 2) !== 0;
		permOwnerX = (owner & 1) !== 0;
		permGroupR = (group & 4) !== 0;
		permGroupW = (group & 2) !== 0;
		permGroupX = (group & 1) !== 0;
		permOtherR = (other & 4) !== 0;
		permOtherW = (other & 2) !== 0;
		permOtherX = (other & 1) !== 0;
	}

	// Update octal mode from checkboxes
	function checkboxesToOctal() {
		const owner = (permOwnerR ? 4 : 0) + (permOwnerW ? 2 : 0) + (permOwnerX ? 1 : 0);
		const group = (permGroupR ? 4 : 0) + (permGroupW ? 2 : 0) + (permGroupX ? 1 : 0);
		const other = (permOtherR ? 4 : 0) + (permOtherW ? 2 : 0) + (permOtherX ? 1 : 0);
		chmodMode = `${owner}${group}${other}`;
	}

	// Generate symbolic permission string from checkboxes
	function checkboxesToSymbolic(): string {
		return (permOwnerR ? 'r' : '-') + (permOwnerW ? 'w' : '-') + (permOwnerX ? 'x' : '-') +
			   (permGroupR ? 'r' : '-') + (permGroupW ? 'w' : '-') + (permGroupX ? 'x' : '-') +
			   (permOtherR ? 'r' : '-') + (permOtherW ? 'w' : '-') + (permOtherX ? 'x' : '-');
	}

	// Deleting state
	let deleting = $state<string | null>(null);
	let confirmDeleteEntry = $state<string | null>(null);

	// Load theme preference from localStorage
	onMount(() => {
		const savedTheme = localStorage.getItem('dockhand-editor-theme');
		if (savedTheme === 'dark' || savedTheme === 'light') {
			editorTheme = savedTheme;
		}
		const savedShowHidden = localStorage.getItem('dockhand-filebrowser-show-hidden');
		if (savedShowHidden !== null) {
			showHiddenFiles = savedShowHidden === 'true';
		}
	});

	function toggleEditorTheme() {
		editorTheme = editorTheme === 'light' ? 'dark' : 'light';
		localStorage.setItem('dockhand-editor-theme', editorTheme);
	}

	function toggleHiddenFiles() {
		showHiddenFiles = !showHiddenFiles;
		localStorage.setItem('dockhand-filebrowser-show-hidden', String(showHiddenFiles));
	}

	// Max file size for editing (1MB)
	const MAX_EDITABLE_SIZE = 1024 * 1024;

	// Get language from filename for CodeMirror
	function getLanguageFromFilename(filename: string): string {
		const name = filename.toLowerCase();
		if (name === 'dockerfile') return 'shell';
		if (name === 'makefile' || name === 'rakefile') return 'shell';
		if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'yaml';
		if (name.endsWith('.json')) return 'json';
		if (name.endsWith('.md')) return 'markdown';
		if (name.endsWith('.sh') || name.endsWith('.bash') || name.endsWith('.zsh') ||
			name === '.bashrc' || name === '.zshrc' || name === '.profile' ||
			name === '.bash_profile' || name === '.bash_aliases') return 'shell';
		if (name.endsWith('.js') || name.endsWith('.jsx')) return 'javascript';
		if (name.endsWith('.ts') || name.endsWith('.tsx')) return 'typescript';
		if (name.endsWith('.py')) return 'python';
		if (name.endsWith('.html') || name.endsWith('.htm')) return 'html';
		if (name.endsWith('.css') || name.endsWith('.scss') || name.endsWith('.sass') || name.endsWith('.less')) return 'css';
		if (name.endsWith('.xml')) return 'xml';
		if (name.endsWith('.sql')) return 'sql';
		return 'shell';
	}

	// Check if file is editable
	function isEditable(entry: FileEntry): boolean {
		if (entry.type !== 'file') return false;
		if (entry.size > MAX_EDITABLE_SIZE) return false;
		return true;
	}

	// Check if file is viewable
	function isViewable(entry: FileEntry): boolean {
		if (entry.type !== 'file') return false;
		if (entry.size > MAX_EDITABLE_SIZE) return false;
		return true;
	}

	// Sorted and filtered entries
	const displayEntries = $derived(() => {
		let filtered = entries;

		// Filter hidden files
		if (!showHiddenFiles) {
			filtered = filtered.filter(e => !e.name.startsWith('.'));
		}

		// Sort entries
		return [...filtered].sort((a, b) => {
			// Directories always first
			if (a.type === 'directory' && b.type !== 'directory') return -1;
			if (a.type !== 'directory' && b.type === 'directory') return 1;

			let cmp = 0;
			switch (sortField) {
				case 'name':
					cmp = a.name.localeCompare(b.name);
					break;
				case 'size':
					cmp = a.size - b.size;
					break;
				case 'modified':
					cmp = new Date(a.modified).getTime() - new Date(b.modified).getTime();
					break;
				case 'type':
					cmp = a.type.localeCompare(b.type);
					if (cmp === 0) cmp = a.name.localeCompare(b.name);
					break;
			}

			return sortDirection === 'asc' ? cmp : -cmp;
		});
	});

	// Toggle sort
	function toggleSort(field: SortField) {
		if (sortField === field) {
			sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			sortField = field;
			sortDirection = 'asc';
		}
	}

	// Get sort icon
	function getSortIcon(field: SortField) {
		if (sortField !== field) return ArrowUpDown;
		return sortDirection === 'asc' ? ArrowUp : ArrowDown;
	}

	// Open file for viewing (read-only)
	async function openFileForView(entry: FileEntry) {
		const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
		loadingFile = true;

		try {
			const params = new URLSearchParams({ path: filePath });
			if (envId) params.set('env', envId.toString());

			let res: Response;
			if (isVolumeMode) {
				res = await fetch(`/api/volumes/${encodeURIComponent(volumeName!)}/browse/content?${params}`);
			} else {
				res = await fetch(`/api/containers/${effectiveContainerId}/files/content?${params}`);
			}
			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || 'Failed to read file');
			}

			viewingFile = {
				name: entry.name,
				path: filePath,
				content: data.content
			};
		} catch (err: any) {
			toast.error(err.message || 'Failed to open file');
		} finally {
			loadingFile = false;
		}
	}

	function closeViewer() {
		viewingFile = null;
	}

	// Open file for editing
	async function openFileForEdit(entry: FileEntry) {
		const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
		const containerPath = getContainerPath(filePath);
		loadingFile = true;

		try {
			const params = new URLSearchParams({ path: containerPath });
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/content?${params}`);
			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || 'Failed to read file');
			}

			editorContent = data.content;
			editingFile = {
				name: entry.name,
				path: filePath,
				content: data.content
			};
		} catch (err: any) {
			toast.error(err.message || 'Failed to open file');
		} finally {
			loadingFile = false;
		}
	}

	async function saveFile() {
		if (!editingFile) return;

		savingFile = true;
		try {
			const containerPath = getContainerPath(editingFile.path);
			const params = new URLSearchParams({ path: containerPath });
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/content?${params}`, {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content: editorContent })
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || 'Failed to save file');
			}

			toast.success('File saved');
			closeEditor();
		} catch (err: any) {
			toast.error(err.message || 'Failed to save file');
		} finally {
			savingFile = false;
		}
	}

	function closeEditor() {
		editingFile = null;
		editorContent = '';
	}

	// Create file or directory
	async function handleCreate() {
		if (!createName.trim()) {
			toast.error('Name is required');
			return;
		}

		creating = true;
		try {
			const fullPath = currentPath === '/' ? `/${createName}` : `${currentPath}/${createName}`;
			const containerPath = getContainerPath(fullPath);
			const params = new URLSearchParams();
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/create?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: containerPath, type: createType })
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || 'Failed to create');
			}

			toast.success(`${createType === 'file' ? 'File' : 'Directory'} created`);
			showCreateModal = false;
			createName = '';
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || 'Failed to create');
		} finally {
			creating = false;
		}
	}

	// Delete file or directory
	async function handleDelete(entry: FileEntry) {
		const fullPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
		const containerPath = getContainerPath(fullPath);
		deleting = entry.name;

		try {
			const params = new URLSearchParams({ path: containerPath });
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/delete?${params}`, {
				method: 'DELETE'
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || 'Failed to delete');
			}

			toast.success(`Deleted ${entry.name}`);
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || 'Failed to delete');
		} finally {
			deleting = null;
		}
	}

	// Rename file or directory
	function openRenameModal(entry: FileEntry) {
		renameEntry = entry;
		renameName = entry.name;
		showRenameModal = true;
	}

	async function handleRename() {
		if (!renameEntry || !renameName.trim()) {
			toast.error('Name is required');
			return;
		}

		if (renameName === renameEntry.name) {
			showRenameModal = false;
			return;
		}

		renaming = true;
		try {
			const oldPath = currentPath === '/' ? `/${renameEntry.name}` : `${currentPath}/${renameEntry.name}`;
			const newPath = currentPath === '/' ? `/${renameName}` : `${currentPath}/${renameName}`;
			const containerOldPath = getContainerPath(oldPath);
			const containerNewPath = getContainerPath(newPath);
			const params = new URLSearchParams();
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/rename?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ oldPath: containerOldPath, newPath: containerNewPath })
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || 'Failed to rename');
			}

			toast.success('Renamed successfully');
			showRenameModal = false;
			renameEntry = null;
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || 'Failed to rename');
		} finally {
			renaming = false;
		}
	}

	// Change permissions
	function openChmodModal(entry: FileEntry) {
		chmodEntry = entry;
		// Convert permissions string to octal
		chmodMode = permissionsToOctal(entry.permissions);
		// Also update checkboxes from octal
		octalToCheckboxes(chmodMode);
		chmodRecursive = false;
		showChmodModal = true;
	}

	function permissionsToOctal(perms: string): string {
		// perms is like "rwxr-xr-x"
		const parseTriple = (s: string) => {
			let val = 0;
			if (s[0] === 'r') val += 4;
			if (s[1] === 'w') val += 2;
			if (s[2] === 'x' || s[2] === 's' || s[2] === 't') val += 1;
			return val;
		};

		if (perms.length < 9) return '644';

		const owner = parseTriple(perms.slice(0, 3));
		const group = parseTriple(perms.slice(3, 6));
		const other = parseTriple(perms.slice(6, 9));

		return `${owner}${group}${other}`;
	}

	async function handleChmod() {
		if (!chmodEntry || !chmodMode.trim()) {
			toast.error('Mode is required');
			return;
		}

		changingPerms = true;
		try {
			const fullPath = currentPath === '/' ? `/${chmodEntry.name}` : `${currentPath}/${chmodEntry.name}`;
			const containerPath = getContainerPath(fullPath);
			const params = new URLSearchParams();
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/chmod?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: containerPath, mode: chmodMode, recursive: chmodRecursive })
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || 'Failed to change permissions');
			}

			toast.success('Permissions changed');
			showChmodModal = false;
			chmodEntry = null;
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || 'Failed to change permissions');
		} finally {
			changingPerms = false;
		}
	}

	// Format file size
	function formatSize(bytes: number): string {
		if (bytes === 0) return '-';
		const units = ['B', 'KB', 'MB', 'GB'];
		let size = bytes;
		let unitIndex = 0;
		while (size >= 1024 && unitIndex < units.length - 1) {
			size /= 1024;
			unitIndex++;
		}
		return `${size.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
	}

	function formatDate(isoDate: string): string {
		try {
			return formatDateTime(isoDate);
		} catch {
			return isoDate;
		}
	}

	function getIcon(entry: FileEntry) {
		switch (entry.type) {
			case 'directory':
				return Folder;
			case 'symlink':
				return Link;
			case 'file':
				return File;
			default:
				return FileQuestion;
		}
	}

	// Load directory contents
	async function loadDirectory(path: string) {
		loading = true;
		error = null;

		try {
			const params = new URLSearchParams({ path });
			if (envId) params.set('env', envId.toString());

			let res: Response;
			let data: any;

			if (isVolumeMode) {
				res = await fetch(`/api/volumes/${encodeURIComponent(volumeName!)}/browse?${params}`);
				data = await res.json();

				// Capture volume usage info and helper container ID from response
				if (data.usage !== undefined) {
					volumeUsage = data.usage;
					volumeIsInUse = data.isInUse ?? false;
					onUsageChange?.(volumeUsage, volumeIsInUse);
				}
				if (data.helperId) {
					volumeHelperId = data.helperId;
				}
			} else {
				if (useSimpleLs) params.set('simpleLs', 'true');

				res = await fetch(`/api/containers/${effectiveContainerId}/files?${params}`);
				data = await res.json();

				if (!res.ok && !useSimpleLs) {
					params.set('simpleLs', 'true');
					res = await fetch(`/api/containers/${effectiveContainerId}/files?${params}`);
					data = await res.json();
					if (res.ok) {
						useSimpleLs = true;
					}
				}
			}

			if (!res.ok) {
				throw new Error(data.error || 'Failed to load directory');
			}

			currentPath = data.path || path;
			entries = data.entries || [];
		} catch (err: any) {
			error = err.message;
			entries = [];
		} finally {
			loading = false;
		}
	}

	function navigateTo(path: string) {
		loadDirectory(path);
	}

	function goUp() {
		if (currentPath === '/') return;
		const parts = currentPath.split('/').filter(Boolean);
		parts.pop();
		navigateTo('/' + parts.join('/') || '/');
	}

	function goHome() {
		navigateTo('/');
	}

	function handleEntryClick(entry: FileEntry) {
		if (entry.type === 'directory') {
			const newPath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
			navigateTo(newPath);
		} else if (selectMode && entry.type === 'file') {
			// In select mode, clicking a file selects it
			const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
			selectedFilePath = filePath;
			onFileSelect?.(filePath, entry.name);
		}
		// Symlinks are not navigable - target path is displayed for reference
	}

	function downloadFile(entry: FileEntry) {
		const filePath =
			currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
		const params = new URLSearchParams({
			path: filePath,
			format: $appSettings.downloadFormat
		});
		if (envId) params.set('env', envId.toString());

		let url: string;
		if (isVolumeMode) {
			url = `/api/volumes/${encodeURIComponent(volumeName!)}/export?${params}`;
		} else {
			url = `/api/containers/${effectiveContainerId}/files/download?${params}`;
		}
		window.open(url, '_blank');
	}

	async function handleFileUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = input.files;
		if (!files || files.length === 0) return;

		uploading = true;

		try {
			const formData = new FormData();
			for (const file of files) {
				formData.append('files', file);
			}

			const containerPath = getContainerPath(currentPath);
			const params = new URLSearchParams({ path: containerPath });
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/upload?${params}`, {
				method: 'POST',
				body: formData
			});

			const data = await res.json();

			if (!res.ok) {
				const details = data.details?.join('; ') || '';
				throw new Error(details || data.error || 'Upload failed');
			}

			toast.success(`Uploaded ${data.uploaded.length} file(s)`);
			if (data.errors?.length) {
				toast.error(`Failed: ${data.errors.join(', ')}`);
			}

			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || 'Upload failed');
		} finally {
			uploading = false;
			input.value = '';
		}
	}

	const pathSegments = $derived(() => {
		if (currentPath === '/') return [];
		return currentPath.split('/').filter(Boolean);
	});

	$effect(() => {
		loadDirectory(initialPath);
	});
</script>

<div class="flex flex-col h-full relative">
	<!-- Header with breadcrumbs and actions -->
	<div class="flex items-center gap-2 p-2 border-b bg-muted/30">
		<Button variant="ghost" size="icon" class="h-7 w-7" onclick={goUp} disabled={currentPath === '/'}>
			<ChevronLeft class="w-3.5 h-3.5" />
		</Button>
		<Button variant="ghost" size="icon" class="h-7 w-7" onclick={goHome}>
			<Home class="w-3.5 h-3.5" />
		</Button>

		<!-- Breadcrumbs -->
		<div class="flex-1 flex items-center gap-1 text-xs overflow-x-auto">
			<button
				type="button"
				class="text-muted-foreground hover:text-foreground px-1"
				onclick={() => navigateTo('/')}
			>
				/
			</button>
			{#each pathSegments() as segment, i}
				<ChevronRight class="w-3 h-3 text-muted-foreground shrink-0" />
				<button
					type="button"
					class="text-muted-foreground hover:text-foreground px-1 truncate max-w-[150px]"
					title={segment}
					onclick={() => navigateTo('/' + pathSegments().slice(0, i + 1).join('/'))}
				>
					{segment}
				</button>
			{/each}
		</div>

		<!-- Actions -->
		{#if effectiveCanEdit}
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				onclick={() => { createType = 'file'; createName = ''; showCreateModal = true; }}
				title="New file"
			>
				<FilePlus class="w-3.5 h-3.5" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				onclick={() => { createType = 'directory'; createName = ''; showCreateModal = true; }}
				title="New directory"
			>
				<FolderPlus class="w-3.5 h-3.5" />
			</Button>
			<input
				bind:this={fileInput}
				type="file"
				multiple
				class="hidden"
				onchange={handleFileUpload}
			/>
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				onclick={() => fileInput.click()}
				disabled={uploading || loading}
				title="Upload files"
			>
				{#if uploading}
					<Loader2 class="w-3.5 h-3.5 animate-spin" />
				{:else}
					<Upload class="w-3.5 h-3.5" />
				{/if}
			</Button>
		{/if}
		<Button
			variant="ghost"
			size="icon"
			class="h-7 w-7"
			onclick={toggleHiddenFiles}
			title={showHiddenFiles ? 'Hide hidden files' : 'Show hidden files'}
		>
			{#if showHiddenFiles}
				<Eye class="w-3.5 h-3.5" />
			{:else}
				<EyeOff class="w-3.5 h-3.5" />
			{/if}
		</Button>
		<Button
			variant="ghost"
			size="icon"
			class="h-7 w-7"
			onclick={() => loadDirectory(currentPath)}
			disabled={loading}
			title="Refresh"
		>
			<RefreshCw class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
		</Button>
	</div>

	<!-- File list -->
	<div class="flex-1 overflow-auto relative">
		{#if loading}
			<div class="absolute inset-0 bg-background/80 flex items-center justify-center z-10">
				<Loader2 class="w-5 h-5 animate-spin mr-2 text-muted-foreground" />
				<span class="text-sm text-muted-foreground">Loading...</span>
			</div>
		{/if}
		{#if error}
			<div class="flex items-center justify-center p-4 h-full">
				<div class="max-w-md bg-destructive/5 border border-destructive/20 rounded-lg p-4 text-center">
					<AlertCircle class="w-6 h-6 text-destructive mx-auto" />
					<p class="text-sm font-medium text-destructive mt-2">Unable to browse files</p>
					<p class="text-xs text-muted-foreground mt-2 break-words font-mono bg-muted/50 rounded px-2 py-1.5">{error}</p>
					<Button variant="outline" size="sm" class="mt-3" onclick={() => loadDirectory(currentPath)}>
						Retry
					</Button>
				</div>
			</div>
		{:else if !loading && displayEntries().length === 0}
			<div class="flex items-center justify-center h-32 text-muted-foreground">
				<span class="text-sm">{showHiddenFiles ? 'Directory is empty' : 'No visible files (hidden files are hidden)'}</span>
			</div>
		{:else if displayEntries().length > 0}
			<Table.Root class="text-xs">
				<Table.Header>
					<Table.Row>
						<Table.Head class="w-[35%] py-1.5 text-xs font-medium">
							<button type="button" class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('name')}>
								Name
								<svelte:component this={getSortIcon('name')} class="w-3 h-3 opacity-50" />
							</button>
						</Table.Head>
						<Table.Head class="w-[8%] py-1.5 text-xs font-medium">
							<button type="button" class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('size')}>
								Size
								<svelte:component this={getSortIcon('size')} class="w-3 h-3 opacity-50" />
							</button>
						</Table.Head>
						<Table.Head class="w-[18%] py-1.5 text-xs font-medium">
							<span class="text-muted-foreground">Permissions</span>
						</Table.Head>
						<Table.Head class="w-[14%] py-1.5 text-xs font-medium">
							<button type="button" class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('modified')}>
								Modified
								<svelte:component this={getSortIcon('modified')} class="w-3 h-3 opacity-50" />
							</button>
						</Table.Head>
						<Table.Head class="w-[25%] py-1.5 text-xs font-medium text-right">Actions</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each displayEntries() as entry (entry.name)}
						{@const Icon = getIcon(entry)}
						{@const isClickable = entry.type === 'directory' || (selectMode && entry.type === 'file')}
						{@const isSelectable = selectMode && entry.type === 'file' && matchesSelectFilter(entry.name)}
						{@const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`}
						{@const isSelected = selectMode && selectedFilePath === filePath}
						<Table.Row class="{isClickable ? 'cursor-pointer' : ''} hover:bg-muted/50 group {isSelected ? 'bg-primary/10 hover:bg-primary/15' : ''} {isSelectable ? 'border-l-2 border-l-primary' : ''}">
							<Table.Cell class="py-1">
								<button
									type="button"
									class="flex items-center gap-1.5 w-full text-left {isClickable ? '' : 'cursor-default'}"
									onclick={() => handleEntryClick(entry)}
								>
									<Icon
										class="w-3.5 h-3.5 shrink-0 {entry.type === 'directory'
											? 'text-blue-500'
											: entry.type === 'symlink'
												? 'text-purple-500'
												: 'text-muted-foreground'}"
									/>
									<span class="truncate" title={entry.name}>
										{entry.name}
										{#if entry.type === 'symlink' && entry.linkTarget}
											<span class="text-muted-foreground ml-1">
												→ {entry.linkTarget}
											</span>
										{/if}
									</span>
									{#if entry.readonly && entry.type === 'file'}
										<span
											class="inline-flex items-center gap-0.5 ml-1.5 px-1 py-0.5 text-2xs bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded"
											title="Read-only file (no write permission)"
										>
											<Lock class="w-2.5 h-2.5" />
											RO
										</span>
									{/if}
								</button>
							</Table.Cell>
							<Table.Cell class="text-muted-foreground py-1">
								{entry.type === 'directory' ? '-' : formatSize(entry.size)}
							</Table.Cell>
							<Table.Cell class="text-muted-foreground py-1 font-mono text-2xs">
								<span title={entry.permissions}>{permissionsToOctal(entry.permissions)}</span>
								<span class="ml-1 opacity-60">{entry.permissions}</span>
							</Table.Cell>
							<Table.Cell class="text-muted-foreground py-1">
								{formatDate(entry.modified)}
							</Table.Cell>
							<Table.Cell class="text-right py-1">
								<div class="flex items-center justify-end gap-0.5">
									{#if isViewable(entry)}
										<Button
											variant="ghost"
											size="icon"
											class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onclick={(e: MouseEvent) => { e.stopPropagation(); openFileForView(entry); }}
											disabled={loadingFile}
											title="View file"
										>
											<Eye class="w-3 h-3" />
										</Button>
									{/if}
									{#if effectiveCanEdit && isEditable(entry)}
										<Button
											variant="ghost"
											size="icon"
											class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity {entry.readonly ? 'cursor-not-allowed' : ''}"
											onclick={(e: MouseEvent) => { e.stopPropagation(); if (!entry.readonly) openFileForEdit(entry); }}
											disabled={loadingFile || entry.readonly}
											title={entry.readonly ? "File is read-only" : "Edit file"}
										>
											{#if loadingFile}
												<Loader2 class="w-3 h-3 animate-spin" />
											{:else if entry.readonly}
												<Lock class="w-3 h-3 text-muted-foreground" />
											{:else}
												<Pencil class="w-3 h-3" />
											{/if}
										</Button>
									{/if}
									{#if effectiveCanEdit}
										<Button
											variant="ghost"
											size="icon"
											class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onclick={(e: MouseEvent) => { e.stopPropagation(); openRenameModal(entry); }}
											title="Rename"
										>
											<TextCursorInput class="w-3 h-3" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onclick={(e: MouseEvent) => { e.stopPropagation(); openChmodModal(entry); }}
											title="Change permissions"
										>
											<Shield class="w-3 h-3" />
										</Button>
										<ConfirmPopover
											open={confirmDeleteEntry === entry.name}
											action="Delete"
											itemType={entry.type === 'directory' ? 'directory' : 'file'}
											itemName={entry.name}
											confirmText="Delete"
											variant="destructive"
											onConfirm={() => handleDelete(entry)}
											onOpenChange={(open) => confirmDeleteEntry = open ? entry.name : null}
										>
											{#snippet children({ open })}
												{#if deleting === entry.name}
													<Loader2 class="w-3 h-3 animate-spin" />
												{:else}
													<Trash2 class="w-3 h-3 {open ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}" />
												{/if}
											{/snippet}
										</ConfirmPopover>
									{/if}
									<Button
										variant="ghost"
										size="icon"
										class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
										onclick={(e: MouseEvent) => { e.stopPropagation(); downloadFile(entry); }}
										title="Download"
									>
										<Download class="w-3 h-3" />
									</Button>
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		{/if}
	</div>

	<!-- File Editor Overlay -->
	{#if editingFile}
		<div class="absolute inset-0 bg-background flex flex-col z-10">
			<div class="flex items-center justify-between p-2 border-b bg-muted/30">
				<div class="flex items-center gap-2 text-xs">
					<File class="w-3.5 h-3.5 text-muted-foreground" />
					<span class="font-medium">{editingFile.name}</span>
					<span class="text-muted-foreground">{editingFile.path}</span>
				</div>
				<div class="flex items-center gap-1">
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={toggleEditorTheme} title={editorTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}>
						{#if editorTheme === 'light'}
							<Moon class="w-3.5 h-3.5" />
						{:else}
							<Sun class="w-3.5 h-3.5" />
						{/if}
					</Button>
					<Button variant="outline" size="sm" class="h-7 text-xs" onclick={saveFile} disabled={savingFile}>
						{#if savingFile}
							<Loader2 class="w-3.5 h-3.5 mr-1.5 animate-spin" />
						{:else}
							<Save class="w-3.5 h-3.5 mr-1.5" />
						{/if}
						Save
					</Button>
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={closeEditor} title="Close editor">
						<X class="w-3.5 h-3.5" />
					</Button>
				</div>
			</div>
			<div class="flex-1 overflow-hidden">
				<CodeEditor
					value={editingFile.content}
					language={getLanguageFromFilename(editingFile.name)}
					theme={editorTheme}
					onchange={(v) => editorContent = v}
				/>
			</div>
		</div>
	{/if}

	<!-- File Viewer Overlay -->
	{#if viewingFile}
		<div class="absolute inset-0 bg-background flex flex-col z-10">
			<div class="flex items-center justify-between p-2 border-b bg-muted/30">
				<div class="flex items-center gap-2 text-xs">
					<Eye class="w-3.5 h-3.5 text-muted-foreground" />
					<span class="font-medium">{viewingFile.name}</span>
					<span class="text-muted-foreground">{viewingFile.path}</span>
					<span class="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">read-only</span>
				</div>
				<div class="flex items-center gap-1">
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={toggleEditorTheme} title={editorTheme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}>
						{#if editorTheme === 'light'}
							<Moon class="w-3.5 h-3.5" />
						{:else}
							<Sun class="w-3.5 h-3.5" />
						{/if}
					</Button>
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={closeViewer} title="Close viewer">
						<X class="w-3.5 h-3.5" />
					</Button>
				</div>
			</div>
			<div class="flex-1 overflow-hidden">
				<CodeEditor
					value={viewingFile.content}
					language={getLanguageFromFilename(viewingFile.name)}
					theme={editorTheme}
					readonly={true}
				/>
			</div>
		</div>
	{/if}
</div>

<!-- Create File/Directory Modal -->
<Dialog.Root bind:open={showCreateModal}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Create {createType === 'file' ? 'File' : 'Directory'}</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="create-name">Name</Label>
				<Input
					id="create-name"
					bind:value={createName}
					placeholder={createType === 'file' ? 'filename.txt' : 'directory-name'}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleCreate(); }}
				/>
			</div>
			<p class="text-xs text-muted-foreground">
				Will be created in: {currentPath}
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showCreateModal = false}>Cancel</Button>
			<Button onclick={handleCreate} disabled={creating || !createName.trim()}>
				{#if creating}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{/if}
				Create
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Rename Modal -->
<Dialog.Root bind:open={showRenameModal}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Rename</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="rename-name">New name</Label>
				<Input
					id="rename-name"
					bind:value={renameName}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleRename(); }}
				/>
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showRenameModal = false}>Cancel</Button>
			<Button onclick={handleRename} disabled={renaming || !renameName.trim()}>
				{#if renaming}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{/if}
				Rename
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Chmod Modal -->
<Dialog.Root bind:open={showChmodModal}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>Change permissions</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4 py-4">
			{#if chmodEntry}
				<p class="text-sm text-muted-foreground">{chmodEntry.name}</p>
				<p class="text-xs text-muted-foreground">Current: {chmodEntry.permissions}</p>
			{/if}

			<!-- Permission checkboxes -->
			<div class="border rounded-lg p-3">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-muted-foreground text-xs">
							<th class="text-left font-normal pb-2"></th>
							<th class="text-center font-normal pb-2 w-16">Read</th>
							<th class="text-center font-normal pb-2 w-16">Write</th>
							<th class="text-center font-normal pb-2 w-16">Execute</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td class="py-1.5 text-muted-foreground">Owner</td>
							<td class="text-center"><input type="checkbox" bind:checked={permOwnerR} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permOwnerW} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permOwnerX} onchange={checkboxesToOctal} class="rounded" /></td>
						</tr>
						<tr>
							<td class="py-1.5 text-muted-foreground">Group</td>
							<td class="text-center"><input type="checkbox" bind:checked={permGroupR} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permGroupW} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permGroupX} onchange={checkboxesToOctal} class="rounded" /></td>
						</tr>
						<tr>
							<td class="py-1.5 text-muted-foreground">Others</td>
							<td class="text-center"><input type="checkbox" bind:checked={permOtherR} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permOtherW} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permOtherX} onchange={checkboxesToOctal} class="rounded" /></td>
						</tr>
					</tbody>
				</table>
			</div>

			<!-- Preview -->
			<div class="flex items-center gap-4 text-sm bg-muted/50 rounded-lg p-3">
				<div>
					<span class="text-muted-foreground text-xs">Octal:</span>
					<span class="font-mono font-medium ml-1">{chmodMode}</span>
				</div>
				<div>
					<span class="text-muted-foreground text-xs">Symbolic:</span>
					<span class="font-mono font-medium ml-1">{checkboxesToSymbolic()}</span>
				</div>
			</div>

			<!-- Manual octal input -->
			<div class="space-y-2">
				<Label for="chmod-mode">Or enter octal mode directly</Label>
				<Input
					id="chmod-mode"
					bind:value={chmodMode}
					placeholder="755"
					maxlength={4}
					oninput={() => octalToCheckboxes(chmodMode)}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleChmod(); }}
				/>
			</div>

			{#if chmodEntry?.type === 'directory'}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" bind:checked={chmodRecursive} class="rounded" />
					Apply recursively
				</label>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showChmodModal = false}>Cancel</Button>
			<Button onclick={handleChmod} disabled={changingPerms || !chmodMode.trim()}>
				{#if changingPerms}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{/if}
				Apply
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
