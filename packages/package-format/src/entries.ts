/**
 * an entry that isn't converted: `pending` when the package was written without asset conversion, `failed`
 * when conversion failed (the reason is in `debug/assets.json`). draws referencing it are skipped
 */
export interface UnconvertedEntry {
	id: number;
	status: 'pending' | 'failed';
}
