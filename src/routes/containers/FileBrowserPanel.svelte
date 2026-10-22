<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { readJobResponse } from '$lib/utils/sse-fetch';
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
		TextCursorInput,
		UserCog
	} from 'lucide-svelte';
	import { toast } from 'svelte-sonner';
	import { LoadingState } from '$lib/components/ui/loading-state';
	import { formatDateTime, appSettings } from '$lib/stores/settings';
	import { m } from '$lib/paraglide/messages.js';

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

	type BrowserMode = 'container' | 'volume' | 'snapshot';
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
		// Snapshot browsing mode
		snapshotId?: string;
		destinationId?: number;
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
		onFileSelect,
		snapshotId,
		destinationId
	}: Props = $props();

	// For volume mode, track whether volume is in use (controls editing ability)
	let volumeIsInUse = $state(false);
	let volumeUsage = $state<VolumeUsageInfo[]>([]);
	// Helper container ID for volume file operations (use container endpoints with this ID)
	let volumeHelperId = $state<string | null>(null);

	// Determine mode based on which prop is provided
	const mode: BrowserMode = $derived(snapshotId ? 'snapshot' : volumeName ? 'volume' : 'container');
	const isVolumeMode = $derived(mode === 'volume');
	const isSnapshotMode = $derived(mode === 'snapshot');

	// In a snapshot, the stack dir rides a reserved volume key; show it by what it holds,
	// not the raw internal key. Navigation still uses the real name.
	function displayEntryName(name: string): string {
		if (isSnapshotMode && name === '__dockhand_stackdir__') return m.containers_files_stack_files_entry();
		return name;
	}

	// A raw download of the snapshot's metadata.json is refused server-side (403) — it carries
	// secrets and must only leave through the redacting metadata endpoint. So don't offer a
	// download button that would always fail; the file is still previewable (redacted).
	function canDownloadEntry(entry: FileEntry): boolean {
		if (!isSnapshotMode) return true;
		return !(entry.name === 'metadata.json' && (currentPath === '/metadata' || currentPath === '/metadata/'));
	}

	// Effective canEdit: snapshots are always read-only; volumes only if not in use
	const effectiveCanEdit = $derived(
		isSnapshotMode ? false : isVolumeMode ? (canEdit && !volumeIsInUse) : canEdit
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
	// Preview-only loading flag (distinct from loadingFile, which also covers
	// edit/download): drives the "Loading preview…" overlay so a slow restic dump
	// from a remote repo (B2/S3) shows immediate feedback in-place.
	let loadingPreview = $state(false);
	let previewingName = $state('');
	let editorContent = $state('');
	let loadingFile = $state(false);
	// True when the editor buffer differs from the loaded file (unsaved changes).
	let editorDirty = $derived(!!editingFile && editorContent !== editingFile.content);
	// Shown when the user tries to close the editor with unsaved changes (#1264).
	let showCloseConfirm = $state(false);
	let savingFile = $state(false);
	let editorTheme = $state<'light' | 'dark'>('dark');

	// Create modal state
	let showCreateModal = $state(false);
	let createType = $state<'file' | 'directory'>('file');
	let createName = $state('');
	let createOwner = $state('');
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

	// Chown modal state
	let showChownModal = $state(false);
	let chownEntry = $state<FileEntry | null>(null);
	let chownOwner = $state('');
	let chownRecursive = $state(false);
	let changingOwner = $state(false);
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

	// ESC inside the file viewer/editor closes JUST the file, not the whole
	// dialog. Captured at window level so the Dialog.Root wrapper never sees
	// the key. When no file is open, ESC bubbles normally and closes the dialog.
	function handleEscape(e: KeyboardEvent) {
		if (e.key !== 'Escape') return;
		if (showCloseConfirm) {
			// Esc on the unsaved-changes prompt = Cancel (keep editing), never discard.
			e.stopPropagation();
			e.preventDefault();
			showCloseConfirm = false;
		} else if (editingFile) {
			e.stopPropagation();
			e.preventDefault();
			closeEditor();
		} else if (viewingFile) {
			e.stopPropagation();
			e.preventDefault();
			closeViewer();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleEscape, true);
	});
	onDestroy(() => {
		window.removeEventListener('keydown', handleEscape, true);
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
		if (name === 'dockerfile' || name.endsWith('.dockerfile')) return 'dockerfile';
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
		if (name.endsWith('.toml')) return 'toml';
		if (name === '.env' || name.startsWith('.env.') || name.endsWith('.env')) return 'dotenv';
		if (name.endsWith('.ini') || name.endsWith('.conf') || name.endsWith('.cfg') || name.endsWith('.properties')) return 'ini';
		return '';
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
		loadingPreview = true;
		previewingName = entry.name;

		try {
			let res: Response;
			let data: any;
			if (isSnapshotMode) {
				const params = new URLSearchParams({ destinationId: String(destinationId), path: filePath });
				// Job-polling (readJobResponse) so a slow `restic dump` behind a proxy isn't aborted at ~15s.
				res = await fetch(`/api/backup/snapshots/${snapshotId}/dump?${params}`, {
					headers: { Accept: 'text/event-stream' }
				});
				data = await readJobResponse(res);
				if (data?.error) throw new Error(data.error);
			} else {
				const params = new URLSearchParams({ path: filePath });
				if (envId) params.set('env', envId.toString());
				if (isVolumeMode) {
					res = await fetch(`/api/volumes/${encodeURIComponent(volumeName!)}/browse/content?${params}`);
				} else {
					res = await fetch(`/api/containers/${effectiveContainerId}/files/content?${params}`);
				}
				data = await res.json();
				if (!res.ok) {
					throw new Error(data.error || m.containers_files_error_read());
				}
			}

			viewingFile = {
				name: entry.name,
				path: filePath,
				content: data.content
			};
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_open());
		} finally {
			loadingFile = false;
			loadingPreview = false;
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
				throw new Error(data.error || m.containers_files_error_read());
			}

			editorContent = data.content;
			editingFile = {
				name: entry.name,
				path: filePath,
				content: data.content
			};
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_open());
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
				throw new Error(data.error || m.containers_files_error_save());
			}

			toast.success(m.containers_files_saved());
			forceCloseEditor(); // saved → close without re-prompting the dirty guard
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_save());
		} finally {
			savingFile = false;
		}
	}

	// Guarded close: if the buffer has unsaved edits, ask first (#1264).
	function closeEditor() {
		if (editorDirty) {
			showCloseConfirm = true;
			return;
		}
		forceCloseEditor();
	}

	function forceCloseEditor() {
		showCloseConfirm = false;
		editingFile = null;
		editorContent = '';
	}

	// Create file or directory
	async function handleCreate() {
		if (!createName.trim()) {
			toast.error(m.containers_files_name_required());
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
				body: JSON.stringify({ path: containerPath, type: createType, owner: createOwner.trim() || undefined })
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || m.containers_files_error_create());
			}

			toast.success(createType === 'file' ? m.containers_files_file_created() : m.containers_files_directory_created());
			showCreateModal = false;
			createName = '';
			createOwner = '';
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_create());
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
				throw new Error(data.error || m.containers_files_error_delete());
			}

			toast.success(m.containers_files_deleted({ name: entry.name }));
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_delete());
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
			toast.error(m.containers_files_name_required());
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
				throw new Error(data.error || m.containers_files_error_rename());
			}

			toast.success(m.containers_files_renamed());
			showRenameModal = false;
			renameEntry = null;
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_rename());
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
			toast.error(m.containers_files_mode_required());
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
				throw new Error(data.error || m.containers_files_error_chmod());
			}

			toast.success(m.containers_files_chmod_success());
			showChmodModal = false;
			chmodEntry = null;
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_chmod());
		} finally {
			changingPerms = false;
		}
	}

	// Change ownership
	function openChownModal(entry: FileEntry) {
		chownEntry = entry;
		chownOwner = entry.owner || '';
		chownRecursive = false;
		showChownModal = true;
	}

	async function handleChown() {
		if (!chownEntry || !chownOwner.trim()) {
			toast.error(m.containers_files_owner_required());
			return;
		}

		changingOwner = true;
		try {
			const fullPath = currentPath === '/' ? `/${chownEntry.name}` : `${currentPath}/${chownEntry.name}`;
			const containerPath = getContainerPath(fullPath);
			const params = new URLSearchParams();
			if (envId) params.set('env', envId.toString());

			const res = await fetch(`/api/containers/${effectiveContainerId}/files/chown?${params}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: containerPath, owner: chownOwner.trim(), recursive: chownRecursive })
			});

			const data = await res.json();

			if (!res.ok) {
				throw new Error(data.error || m.containers_files_error_chown());
			}

			toast.success(m.containers_files_chown_success());
			showChownModal = false;
			chownEntry = null;
			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_chown());
		} finally {
			changingOwner = false;
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

	// Bumped on every load so a late fallback can tell the user navigated since
	let loadSeq = 0;

	// Load directory contents; resolves false when the listing failed
	async function loadDirectory(path: string): Promise<boolean> {
		loadSeq++;
		loading = true;
		error = null;

		try {
			const params = new URLSearchParams({ path });
			if (envId) params.set('env', envId.toString());

			let res: Response;
			let data: any;

			if (isSnapshotMode) {
				const snapshotParams = new URLSearchParams({ destinationId: String(destinationId), path });
				// Job-polling (readJobResponse) so a slow `restic ls` behind a proxy isn't aborted at ~15s.
				res = await fetch(`/api/backup/snapshots/${snapshotId}/browse?${snapshotParams}`, { headers: { Accept: 'text/event-stream' } });
				data = await readJobResponse(res);
				// A jobified error comes back as { error } with HTTP 200, so surface it explicitly
				// (the shared `if (!res.ok)` gate below can't see it).
				if (data?.error) throw new Error(data.error);
			} else if (isVolumeMode) {
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
				throw new Error(data.error || m.containers_files_error_load_directory());
			}

			currentPath = data.path || path;
			// Map snapshot entries to match FileEntry interface
			if (isSnapshotMode) {
				// restic ls --json gives permissions as a 10-char ls string
				// ("-rw-------": leading type char + 9 rwx). permissionsToOctal wants
				// the 9 rwx chars, so drop the leading type char. Owner/group come as
				// user/group names when the source had /etc/passwd, else numeric uid/gid.
				entries = (data.entries || []).map((e: any) => ({
					name: e.name,
					type: e.type === 'dir' ? 'directory' : e.type,
					size: e.size || 0,
					permissions: typeof e.permissions === 'string' && e.permissions.length >= 10
						? e.permissions.slice(1)
						: '',
					owner: e.user || (e.uid != null ? String(e.uid) : ''),
					group: e.group || (e.gid != null ? String(e.gid) : ''),
					modified: e.mtime || ''
				}));
			} else {
				entries = data.entries || [];
			}
			return true;
		} catch (err: any) {
			error = err.message;
			entries = [];
			return false;
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

		let url: string;
		if (isSnapshotMode) {
			const params = new URLSearchParams({ destinationId: String(destinationId), path: filePath, download: '1' });
			if (entry.type === 'directory') params.set('type', 'directory');
			url = `/api/backup/snapshots/${snapshotId}/dump?${params}`;
		} else {
			const params = new URLSearchParams({ path: filePath, format: $appSettings.downloadFormat });
			if (envId) params.set('env', envId.toString());
			if (isVolumeMode) {
				url = `/api/volumes/${encodeURIComponent(volumeName!)}/export?${params}`;
			} else {
				url = `/api/containers/${effectiveContainerId}/files/download?${params}`;
			}
		}
		window.open(url, '_blank');
	}

	async function handleFileUpload(event: Event) {
		const input = event.target as HTMLInputElement;
		const files = input.files ? Array.from(input.files) : [];
		input.value = '';
		await uploadFiles(files);
	}

	// globalThis.File, not the lucide icon of the same name imported above.
	async function uploadFiles(files: globalThis.File[]) {
		if (files.length === 0) return;

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
				throw new Error(details || data.error || m.containers_files_error_upload());
			}

			toast.success(m.containers_files_uploaded_count({ count: data.uploaded.length }));
			if (data.errors?.length) {
				toast.error(m.containers_files_upload_partial_failed({ errors: data.errors.join(', ') }));
			}

			loadDirectory(currentPath);
		} catch (err: any) {
			toast.error(err.message || m.containers_files_error_upload());
		} finally {
			uploading = false;
		}
	}

	// Drag-and-drop upload into the current directory
	let dragging = $state(false);

	// The drop zone is the whole panel, and the editor and viewer render inside it,
	// so a drop while one of those is open would upload into the directory hidden
	// behind it - and overwrite the open file if the names match.
	const dropTargetReady = $derived(effectiveCanEdit && !editingFile && !viewingFile);

	function handleDragOver(e: DragEvent) {
		if (!dropTargetReady || uploading || !e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		dragging = true;
	}

	function handleDragLeave(e: DragEvent) {
		// dragleave also fires when crossing into a child element; ignore those
		if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) dragging = false;
	}

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		// A drop arrives whether or not dragover ran, so the same check belongs here.
		if (!dropTargetReady || uploading) return;
		const items = Array.from(e.dataTransfer?.items ?? []);
		if (items.some((item) => item.webkitGetAsEntry()?.isDirectory)) {
			toast.error(m.containers_files_folder_upload_unsupported());
			return;
		}
		uploadFiles(Array.from(e.dataTransfer?.files ?? []));
	}

	const pathSegments = $derived(() => {
		if (currentPath === '/') return [];
		return currentPath.split('/').filter(Boolean);
	});

	// Track all identity props so the effect re-fires when they change
	$effect(() => {
		// Read reactive values to establish dependencies
		const _mode = mode;
		const _snap = snapshotId;
		const _dest = destinationId;
		const _cont = containerId;
		const _vol = volumeName;
		const _path = initialPath;

		// Guard: don't load if required props for the mode are missing
		if (_mode === 'snapshot' && (!_snap || !_dest)) return;
		if (_mode === 'container' && !_cont) return;

		currentPath = _path;
		entries = [];
		error = null;
		let stale = false;
		const firstLoad = loadDirectory(_path);
		const seq = loadSeq;
		firstLoad.then((ok) => {
			// A WORKDIR that is missing or unreadable opens root instead of an error (#1285)
			if (!ok && !stale && seq === loadSeq && _mode === 'container' && _path !== '/') loadDirectory('/');
		});
		return () => {
			stale = true;
		};
	});
</script>

<div
	class="flex flex-col h-full relative"
	role="region"
	aria-label={m.containers_files_browser_label()}
	ondragover={handleDragOver}
	ondragleave={handleDragLeave}
	ondrop={handleDrop}
>
	{#if dragging}
		<div class="absolute inset-0 z-20 pointer-events-none flex items-center justify-center gap-2 bg-background/80 border-2 border-dashed border-primary rounded-lg text-sm">
			<Upload class="w-4 h-4" /> {m.containers_files_drop_to_upload({ path: currentPath })}
		</div>
	{/if}
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
					{displayEntryName(segment)}
				</button>
			{/each}
		</div>

		<!-- Actions -->
		{#if effectiveCanEdit}
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				onclick={() => { createType = 'file'; createName = ''; createOwner = ''; showCreateModal = true; }}
				title={m.containers_files_new_file()}
			>
				<FilePlus class="w-3.5 h-3.5" />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				class="h-7 w-7"
				onclick={() => { createType = 'directory'; createName = ''; createOwner = ''; showCreateModal = true; }}
				title={m.containers_files_new_directory()}
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
				title={m.containers_files_upload_files()}
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
			title={showHiddenFiles ? m.containers_files_hide_hidden() : m.containers_files_show_hidden()}
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
			title={m.containers_files_refresh()}
		>
			<RefreshCw class="w-3.5 h-3.5 {loading ? 'animate-spin' : ''}" />
		</Button>
	</div>

	<!-- File list -->
	<div class="flex-1 overflow-auto relative">
		{#if loading}
			<LoadingState class="absolute inset-0 z-10 bg-background/80" label={m.containers_files_loading()} />
		{/if}
		{#if error}
			<div class="flex items-center justify-center p-4 h-full">
				<div class="max-w-md bg-destructive/5 border border-destructive/20 rounded-lg p-4 text-center">
					<AlertCircle class="w-6 h-6 text-destructive mx-auto" />
					<p class="text-sm font-medium text-destructive mt-2">{m.containers_files_browse_error()}</p>
					<p class="text-xs text-muted-foreground mt-2 break-words font-mono bg-muted/50 rounded px-2 py-1.5">{error}</p>
					<Button variant="outline" size="sm" class="mt-3" onclick={() => loadDirectory(currentPath)}>
						{m.containers_files_retry()}
					</Button>
				</div>
			</div>
		{:else if !loading && displayEntries().length === 0}
			<div class="flex items-center justify-center h-32 text-muted-foreground">
				<span class="text-sm">{showHiddenFiles ? m.containers_files_directory_empty() : m.containers_files_no_visible_files()}</span>
			</div>
		{:else if displayEntries().length > 0}
			<!-- Bare <table>, not Table.Root: Table.Root wraps the table in an
			     overflow-x-auto div that becomes the sticky scroll context, so the
			     sticky <thead> would anchor to that non-scrolling wrapper instead of
			     the flex-1 overflow-auto above and never stick. Same pattern DataGrid uses. -->
			<table class="w-full caption-bottom text-sm text-xs">
				<Table.Header class="sticky top-0 z-10 bg-background">
					<Table.Row>
						<Table.Head class="w-[35%] py-1.5 text-xs font-medium">
							<button type="button" class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('name')}>
								{m.containers_files_name()}
								<svelte:component this={getSortIcon('name')} class="w-3 h-3 opacity-50" />
							</button>
						</Table.Head>
						<Table.Head class="w-[8%] py-1.5 text-xs font-medium">
							<button type="button" class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('size')}>
								{m.containers_files_col_size()}
								<svelte:component this={getSortIcon('size')} class="w-3 h-3 opacity-50" />
							</button>
						</Table.Head>
						<Table.Head class="w-[14%] py-1.5 text-xs font-medium">
							<span class="text-muted-foreground">{m.containers_files_col_permissions()}</span>
						</Table.Head>
						<Table.Head class="w-[12%] py-1.5 text-xs font-medium">
							<span class="text-muted-foreground">{m.containers_files_owner()}</span>
						</Table.Head>
						<Table.Head class="w-[14%] py-1.5 text-xs font-medium">
							<button type="button" class="flex items-center gap-1 hover:text-foreground" onclick={() => toggleSort('modified')}>
								{m.containers_files_col_modified()}
								<svelte:component this={getSortIcon('modified')} class="w-3 h-3 opacity-50" />
							</button>
						</Table.Head>
						<Table.Head class="w-[21%] py-1.5 text-xs font-medium text-right">{m.containers_files_col_actions()}</Table.Head>
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
										class="w-3.5 h-3.5 shrink-0 {isSnapshotMode && entry.name === '__dockhand_stackdir__'
											? 'text-amber-500'
											: entry.type === 'directory'
												? 'text-blue-500'
												: entry.type === 'symlink'
													? 'text-purple-500'
													: 'text-muted-foreground'}"
									/>
									<span class="truncate" title={entry.name}>
										{displayEntryName(entry.name)}
										{#if entry.type === 'symlink' && entry.linkTarget}
											<span class="text-muted-foreground ml-1">
												→ {entry.linkTarget}
											</span>
										{/if}
									</span>
									{#if entry.readonly && entry.type === 'file'}
										<span
											class="inline-flex items-center gap-0.5 ml-1.5 px-1 py-0.5 text-2xs bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded"
											title={m.containers_files_readonly_file_title()}
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
							<Table.Cell class="text-muted-foreground py-1 font-mono text-xs">
								<span title={entry.permissions}>{permissionsToOctal(entry.permissions)}</span>
								<span class="ml-1 opacity-60">{entry.permissions}</span>
							</Table.Cell>
							<Table.Cell class="text-muted-foreground py-1 font-mono text-xs">
								{#if entry.owner}
									<span title={entry.group ? `${entry.owner}:${entry.group}` : entry.owner}>{entry.owner}{#if entry.group && entry.group !== entry.owner}<span class="opacity-60">:{entry.group}</span>{/if}</span>
								{:else}
									<span class="opacity-40">-</span>
								{/if}
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
											title={m.containers_files_view_file()}
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
											title={entry.readonly ? m.containers_files_file_readonly() : m.containers_files_edit_file()}
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
											title={m.containers_files_rename()}
										>
											<TextCursorInput class="w-3 h-3" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onclick={(e: MouseEvent) => { e.stopPropagation(); openChmodModal(entry); }}
											title={m.containers_files_change_permissions()}
										>
											<Shield class="w-3 h-3" />
										</Button>
										<Button
											variant="ghost"
											size="icon"
											class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onclick={(e: MouseEvent) => { e.stopPropagation(); openChownModal(entry); }}
											title={m.containers_files_change_owner()}
										>
											<UserCog class="w-3 h-3" />
										</Button>
										<ConfirmPopover
											open={confirmDeleteEntry === entry.name}
											localized
											action={m.confirm_action_delete()}
											itemType={entry.type === 'directory' ? m.containers_files_item_directory() : m.containers_files_item_file()}
											itemName={entry.name}
											confirmText={m.containers_files_delete()}
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
									{#if canDownloadEntry(entry)}
										<Button
											variant="ghost"
											size="icon"
											class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
											onclick={(e: MouseEvent) => { e.stopPropagation(); downloadFile(entry); }}
											title={m.containers_files_download()}
										>
											<Download class="w-3 h-3" />
										</Button>
									{/if}
								</div>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</table>
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
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={toggleEditorTheme} title={editorTheme === 'light' ? m.containers_files_theme_dark() : m.containers_files_theme_light()}>
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
						{m.containers_files_save()}
					</Button>
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={closeEditor} title={m.containers_files_close_editor()}>
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

	<!-- Unsaved-changes confirmation on editor close (#1264) -->
	<Dialog.Root open={showCloseConfirm} onOpenChange={(o) => { if (!o) showCloseConfirm = false; }}>
		<Dialog.Content class="sm:max-w-md">
			<Dialog.Header>
				<Dialog.Title>{m.containers_files_unsaved_title()}</Dialog.Title>
				<Dialog.Description>
					{editingFile ? m.containers_files_unsaved_description({ name: editingFile.name }) : m.containers_files_unsaved_description_unnamed()}
				</Dialog.Description>
			</Dialog.Header>
			<Dialog.Footer class="gap-2 sm:justify-between">
				<Button variant="outline" onclick={() => showCloseConfirm = false}>{m.containers_files_cancel()}</Button>
				<div class="flex gap-2">
					<Button variant="destructive" onclick={forceCloseEditor}>{m.containers_files_discard()}</Button>
					<Button onclick={saveFile} disabled={savingFile}>{m.containers_files_save()}</Button>
				</div>
			</Dialog.Footer>
		</Dialog.Content>
	</Dialog.Root>

	<!-- File Viewer Overlay -->
	{#if loadingPreview && !viewingFile}
		<LoadingState class="absolute inset-0 z-10 bg-background" label={previewingName ? m.containers_files_loading_preview_named({ name: previewingName }) : m.containers_files_loading_preview()} />
	{:else if viewingFile}
		<div class="absolute inset-0 bg-background flex flex-col z-10">
			<div class="flex items-center justify-between p-2 border-b bg-muted/30">
				<div class="flex items-center gap-2 text-xs">
					<Eye class="w-3.5 h-3.5 text-muted-foreground" />
					<span class="font-medium">{viewingFile.name}</span>
					<span class="text-muted-foreground">{viewingFile.path}</span>
					<span class="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{m.containers_files_readonly_badge()}</span>
				</div>
				<div class="flex items-center gap-1">
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={toggleEditorTheme} title={editorTheme === 'light' ? m.containers_files_theme_dark() : m.containers_files_theme_light()}>
						{#if editorTheme === 'light'}
							<Moon class="w-3.5 h-3.5" />
						{:else}
							<Sun class="w-3.5 h-3.5" />
						{/if}
					</Button>
					<Button variant="ghost" size="icon" class="h-7 w-7" onclick={closeViewer} title={m.containers_files_close_viewer()}>
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
			<Dialog.Title>{createType === 'file' ? m.containers_files_create_file_title() : m.containers_files_create_directory_title()}</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="create-name">{m.containers_files_name()}</Label>
				<Input
					id="create-name"
					bind:value={createName}
					placeholder={createType === 'file' ? m.containers_files_filename_placeholder() : m.containers_files_directory_placeholder()}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleCreate(); }}
				/>
			</div>
			<div class="space-y-2">
				<Label for="create-owner">{m.containers_files_owner_optional()}</Label>
				<Input
					id="create-owner"
					bind:value={createOwner}
					placeholder={m.containers_files_owner_placeholder()}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleCreate(); }}
				/>
				<p class="text-xs text-muted-foreground">
					{m.containers_files_owner_default_hint()}
				</p>
			</div>
			<p class="text-xs text-muted-foreground">
				{m.containers_files_create_location({ path: currentPath })}
			</p>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showCreateModal = false}>{m.containers_files_cancel()}</Button>
			<Button onclick={handleCreate} disabled={creating || !createName.trim()}>
				{#if creating}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{/if}
				{m.containers_files_create()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Rename Modal -->
<Dialog.Root bind:open={showRenameModal}>
	<Dialog.Content class="max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{m.containers_files_rename()}</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4 py-4">
			<div class="space-y-2">
				<Label for="rename-name">{m.containers_files_new_name()}</Label>
				<Input
					id="rename-name"
					bind:value={renameName}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleRename(); }}
				/>
			</div>
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showRenameModal = false}>{m.containers_files_cancel()}</Button>
			<Button onclick={handleRename} disabled={renaming || !renameName.trim()}>
				{#if renaming}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{/if}
				{m.containers_files_rename()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<!-- Chmod Modal -->
<Dialog.Root bind:open={showChmodModal}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.containers_files_change_permissions()}</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4 py-4">
			{#if chmodEntry}
				<p class="text-sm text-muted-foreground">{chmodEntry.name}</p>
				<p class="text-xs text-muted-foreground">{m.containers_files_current({ value: chmodEntry.permissions })}</p>
			{/if}

			<!-- Permission checkboxes -->
			<div class="border rounded-lg p-3">
				<table class="w-full text-sm">
					<thead>
						<tr class="text-muted-foreground text-xs">
							<th class="text-left font-normal pb-2"></th>
							<th class="text-center font-normal pb-2 w-16">{m.containers_files_perm_read()}</th>
							<th class="text-center font-normal pb-2 w-16">{m.containers_files_perm_write()}</th>
							<th class="text-center font-normal pb-2 w-16">{m.containers_files_perm_execute()}</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td class="py-1.5 text-muted-foreground">{m.containers_files_owner()}</td>
							<td class="text-center"><input type="checkbox" bind:checked={permOwnerR} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permOwnerW} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permOwnerX} onchange={checkboxesToOctal} class="rounded" /></td>
						</tr>
						<tr>
							<td class="py-1.5 text-muted-foreground">{m.containers_files_perm_group()}</td>
							<td class="text-center"><input type="checkbox" bind:checked={permGroupR} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permGroupW} onchange={checkboxesToOctal} class="rounded" /></td>
							<td class="text-center"><input type="checkbox" bind:checked={permGroupX} onchange={checkboxesToOctal} class="rounded" /></td>
						</tr>
						<tr>
							<td class="py-1.5 text-muted-foreground">{m.containers_files_perm_others()}</td>
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
					<span class="text-muted-foreground text-xs">{m.containers_files_octal()}</span>
					<span class="font-mono font-medium ml-1">{chmodMode}</span>
				</div>
				<div>
					<span class="text-muted-foreground text-xs">{m.containers_files_symbolic()}</span>
					<span class="font-mono font-medium ml-1">{checkboxesToSymbolic()}</span>
				</div>
			</div>

			<!-- Manual octal input -->
			<div class="space-y-2">
				<Label for="chmod-mode">{m.containers_files_octal_input_label()}</Label>
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
					{m.containers_files_apply_recursively()}
				</label>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showChmodModal = false}>{m.containers_files_cancel()}</Button>
			<Button onclick={handleChmod} disabled={changingPerms || !chmodMode.trim()}>
				{#if changingPerms}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{/if}
				{m.containers_files_apply()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={showChownModal}>
	<Dialog.Content class="max-w-md">
		<Dialog.Header>
			<Dialog.Title>{m.containers_files_change_owner()}</Dialog.Title>
		</Dialog.Header>
		<div class="space-y-4 py-4">
			{#if chownEntry}
				<p class="text-sm text-muted-foreground">{chownEntry.name}</p>
				{#if chownEntry.owner}
					<p class="text-xs text-muted-foreground">{m.containers_files_current({ value: chownEntry.owner })}</p>
				{/if}
			{/if}

			<div class="space-y-2">
				<Label for="chown-owner">{m.containers_files_owner()}</Label>
				<Input
					id="chown-owner"
					bind:value={chownOwner}
					placeholder={m.containers_files_owner_placeholder()}
					onkeydown={(e: KeyboardEvent) => { if (e.key === 'Enter') handleChown(); }}
				/>
				<p class="text-xs text-muted-foreground">
					{m.containers_files_chown_hint()}
				</p>
			</div>

			{#if chownEntry?.type === 'directory'}
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" bind:checked={chownRecursive} class="rounded" />
					{m.containers_files_apply_recursively()}
				</label>
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => showChownModal = false}>{m.containers_files_cancel()}</Button>
			<Button onclick={handleChown} disabled={changingOwner || !chownOwner.trim()}>
				{#if changingOwner}
					<Loader2 class="w-4 h-4 mr-2 animate-spin" />
				{/if}
				{m.containers_files_apply()}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
