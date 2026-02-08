<script lang="ts">
	import Cropper from 'svelte-easy-crop';
	import { Button } from '$lib/components/ui/button';
	import { ZoomIn, ZoomOut, X, Check } from 'lucide-svelte';

	interface Props {
		show: boolean;
		imageUrl: string;
		onCancel: () => void;
		onSave: (dataUrl: string) => void;
	}

	let { show, imageUrl, onCancel, onSave }: Props = $props();

	// Cropper state
	let crop = $state({ x: 0, y: 0 });
	let zoom = $state(1);
	let croppedAreaPixels = $state<{ x: number; y: number; width: number; height: number } | null>(null);
	let imageLoaded = $state(false);
	let saving = $state(false);

	// Reset state when imageUrl changes
	$effect(() => {
		if (imageUrl) {
			crop = { x: 0, y: 0 };
			zoom = 1;
			croppedAreaPixels = null;
			imageLoaded = false;

			// Trigger a zoom change to force the cropcomplete event to fire
			setTimeout(() => {
				imageLoaded = true;
				zoom = 1.01;
				setTimeout(() => {
					zoom = 1;
				}, 100);
			}, 500);
		}
	});

	function onCropComplete(e: CustomEvent) {
		const detail = e.detail;

		// svelte-easy-crop returns data in different property names depending on version
		if (detail.pixels) {
			croppedAreaPixels = detail.pixels;
		} else if (detail.croppedAreaPixels) {
			croppedAreaPixels = detail.croppedAreaPixels;
		} else if (detail.pixelCrop) {
			croppedAreaPixels = detail.pixelCrop;
		} else if (detail.x !== undefined && detail.y !== undefined && detail.width !== undefined && detail.height !== undefined) {
			// Fallback: use the detail itself if it has the right properties
			croppedAreaPixels = detail;
		}
	}

	function onMediaLoaded() {
		imageLoaded = true;
	}

	async function computeCropArea(): Promise<{ x: number; y: number; width: number; height: number } | null> {
		return new Promise((resolve) => {
			const image = new Image();
			image.src = imageUrl;

			image.onload = () => {
				// Get the cropper container
				const cropperContainer = document.querySelector('.cropper-container');
				if (!cropperContainer) {
					resolve(null);
					return;
				}

				const containerWidth = cropperContainer.clientWidth;
				const containerHeight = cropperContainer.clientHeight;

				// Calculate how the image is displayed (object-fit: contain)
				const imageAspect = image.width / image.height;
				const containerAspect = containerWidth / containerHeight;

				let mediaWidth, mediaHeight;
				if (imageAspect > containerAspect) {
					mediaWidth = containerWidth;
					mediaHeight = containerWidth / imageAspect;
				} else {
					mediaHeight = containerHeight;
					mediaWidth = containerHeight * imageAspect;
				}

				// Apply zoom
				mediaWidth *= zoom;
				mediaHeight *= zoom;

				// Calculate crop area
				const cropSize = Math.min(containerWidth, containerHeight);
				const scale = image.width / mediaWidth;

				const cropCenterX = containerWidth / 2;
				const cropCenterY = containerHeight / 2;

				const mediaX = (containerWidth - mediaWidth) / 2;
				const mediaY = (containerHeight - mediaHeight) / 2;

				const cropLeftInMedia = cropCenterX - mediaX - crop.x - cropSize / 2;
				const cropTopInMedia = cropCenterY - mediaY - crop.y - cropSize / 2;

				const x = cropLeftInMedia * scale;
				const y = cropTopInMedia * scale;
				const size = cropSize * scale;

				resolve({
					x: Math.max(0, Math.round(x)),
					y: Math.max(0, Math.round(y)),
					width: Math.min(Math.round(size), image.width),
					height: Math.min(Math.round(size), image.height)
				});
			};

			image.onerror = () => resolve(null);
		});
	}

	async function getCroppedImage(): Promise<string> {
		// If no crop data from event, compute it manually
		let cropData = croppedAreaPixels;
		if (!cropData) {
			cropData = await computeCropArea();
		}

		if (!cropData) {
			throw new Error('No crop data available');
		}

		return new Promise((resolve, reject) => {
			const image = new Image();
			image.src = imageUrl;

			image.onload = () => {
				const canvas = document.createElement('canvas');
				const ctx = canvas.getContext('2d');

				if (!ctx) {
					reject(new Error('Failed to get canvas context'));
					return;
				}

				// Set canvas size to output size (256x256 for avatar)
				canvas.width = 256;
				canvas.height = 256;

				// Ensure we use a square crop area to avoid stretching
				// Center the square within the original crop area
				const size = Math.min(cropData!.width, cropData!.height);
				const offsetX = (cropData!.width - size) / 2;
				const offsetY = (cropData!.height - size) / 2;

				// Draw the cropped image
				ctx.drawImage(
					image,
					cropData!.x + offsetX,
					cropData!.y + offsetY,
					size,
					size,
					0,
					0,
					256,
					256
				);

				// Convert to data URL
				const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
				resolve(dataUrl);
			};

			image.onerror = () => {
				reject(new Error('Failed to load image'));
			};
		});
	}

	async function handleSave() {
		saving = true;
		try {
			const dataUrl = await getCroppedImage();
			onSave(dataUrl);
		} catch (err) {
			console.error('Failed to crop image:', err);
		} finally {
			saving = false;
		}
	}

	function handleCancel() {
		crop = { x: 0, y: 0 };
		zoom = 1;
		croppedAreaPixels = null;
		imageLoaded = false;
		onCancel();
	}

	// Handle ESC key
	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && show) {
			handleCancel();
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if show && imageUrl}
	<div class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
		<div class="bg-background rounded-lg w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
			<!-- Header -->
			<div class="p-4 border-b">
				<h3 class="text-lg font-semibold">Crop avatar</h3>
				<p class="text-sm text-muted-foreground mt-1">
					Drag to reposition. Use the slider to zoom.
				</p>
			</div>

			<!-- Cropper Container -->
			<div class="cropper-container relative flex-1 bg-muted min-h-[400px]">
				<Cropper
					image={imageUrl}
					bind:crop
					bind:zoom
					aspect={1}
					cropShape="round"
					showGrid={false}
					on:cropcomplete={onCropComplete}
					on:mediaLoaded={onMediaLoaded}
				/>
			</div>

			<!-- Zoom Controls -->
			<div class="p-4 border-t">
				<div class="flex items-center gap-3">
					<ZoomOut class="w-5 h-5 text-muted-foreground shrink-0" />
					<input
						type="range"
						min="1"
						max="3"
						step="0.1"
						bind:value={zoom}
						class="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
					/>
					<ZoomIn class="w-5 h-5 text-muted-foreground shrink-0" />
				</div>
			</div>

			<!-- Actions -->
			<div class="p-4 border-t flex gap-3">
				<Button
					variant="outline"
					class="flex-1"
					onclick={handleCancel}
					disabled={saving}
				>
					<X class="w-4 h-4" />
					Cancel
				</Button>
				<Button
					class="flex-1"
					onclick={handleSave}
					disabled={saving || !imageLoaded}
				>
					<Check class="w-4 h-4" />
					{saving ? 'Uploading...' : !imageLoaded ? 'Loading...' : 'Save avatar'}
				</Button>
			</div>
		</div>
	</div>
{/if}
