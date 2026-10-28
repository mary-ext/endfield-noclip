import type { Viewer } from '../viewer.ts';

import { useViewerStats } from './use-viewer.ts';

const degrees = (radians: number): string => `${Math.round((radians * 180) / Math.PI)}°`;

/** the camera's Unity-space position, heading and speed, plus the controls */
export const CameraReadout = ({ viewer }: { viewer: Viewer }) => {
	useViewerStats(viewer);
	const { position, yaw, pitch, speed } = viewer.stats.camera;
	const [x, y, z] = position.map((v) => v.toFixed(1));
	return (
		<section className="panel camera" aria-label="camera">
			<p>
				<span className="muted">unity</span> x {x} · y {y} · z {z} <span className="muted">yaw</span>{' '}
				{degrees(yaw)} <span className="muted">pitch</span> {degrees(pitch)}{' '}
				<span className="muted">speed</span> {speed.toFixed(0)} m/s
			</p>
			<p className="muted small">
				click to look · WASD move · E/R up · Q/F down · shift boost · alt slow · wheel base speed · esc
				release
			</p>
		</section>
	);
};
