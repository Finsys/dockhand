// Dashboard disk-usage segment -> page it links to. Build cache has no page of
// its own, so it returns null and the click falls through to the tile (#1314).
export type DiskSegmentKey = 'images' | 'containers' | 'volumes' | 'buildCache';

export function diskSegmentPath(key: DiskSegmentKey): string | null {
	switch (key) {
		case 'images':
			return '/images';
		case 'containers':
			return '/containers';
		case 'volumes':
			return '/volumes';
		default:
			return null;
	}
}
