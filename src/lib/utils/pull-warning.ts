export interface PullWarning {
	status: 'warning';
	message: string;
}

export function collectPullWarning(warnings: PullWarning[], progress: unknown): void {
	const data = progress as Partial<PullWarning> | null;
	if (data?.status === 'warning' && typeof data.message === 'string') {
		warnings.push({ status: 'warning', message: data.message });
	}
}

export function pullLogStatus(data: { status?: string; message?: string }): string | undefined {
	return data.status === 'warning' && data.message ? `[warning] ${data.message}` : data.status;
}
