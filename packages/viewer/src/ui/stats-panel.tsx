import type { Viewer } from '../viewer.ts';

import { formatBytes, formatCount } from './format.ts';
import { useViewerStats } from './use-viewer.ts';

/** frame timing, draw counts, memory and streaming counters */
export const StatsPanel = ({ viewer }: { viewer: Viewer }) => {
	useViewerStats(viewer);
	const s = viewer.stats;
	const rows: [label: string, value: string][] = [
		['frame', `${s.frameMs.toFixed(1)} ms`],
		['cpu', `${s.cpuMs.toFixed(2)} ms`],
		['gpu', s.gpuMs === null ? 'n/a' : `${s.gpuMs.toFixed(2)} ms`],
		['auto exposure', `${s.autoExposureEv >= 0 ? '+' : ''}${s.autoExposureEv.toFixed(2)} EV`],
		['draws (textured)', `${s.draws} (${s.texturedDraws})`],
		['triangles', formatCount(s.triangles)],
		['instances (meshes)', `${formatCount(s.instances)} (${formatCount(s.meshInstances)})`],
		['terrain patches', String(s.terrainPatches)],
		['nodes visited', String(s.nodesVisited)],
		['resident', `${formatBytes(s.residentBytes)} (pinned ${formatBytes(s.pinnedBytes)})`],
		['textures', formatBytes(s.textureBytes)],
		['gpu pools', formatBytes(s.poolBytes)],
		['queued / in flight', `${s.queued} / ${s.requestsInFlight}`],
		['decoding / uploading', `${s.decoding} / ${s.uploading}`],
		['downloaded', `${formatBytes(s.downloadedBytes)} in ${s.requests} requests`],
		['evictions', String(s.evictions)],
		['geometry ready', `${s.geometriesReady} / ${s.geometriesTotal}`],
	];
	if (s.failed > 0) {
		rows.push(['failed blobs', String(s.failed)]);
	}
	return (
		<section className="panel stats" aria-label="statistics">
			{s.packageChanged && (
				<div className="warning" role="alert">
					<p>The package changed on disk. Streaming has stopped.</p>
					<button type="button" onClick={() => location.reload()}>
						Reload
					</button>
				</div>
			)}
			<dl>
				{rows.map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
			<p className="muted small">
				{s.adapter} · {s.features.join(', ')}
			</p>
		</section>
	);
};
