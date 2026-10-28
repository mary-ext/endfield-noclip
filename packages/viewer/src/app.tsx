import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { PackageSource } from './package/package-source.ts';
import { AreasPanel } from './ui/areas-panel.tsx';
import { CameraReadout } from './ui/camera-readout.tsx';
import { type OpenPackage, PackagePanel } from './ui/package-panel.tsx';
import { sourceFromParam } from './ui/package-param.ts';
import { SettingsPanel } from './ui/settings-panel.tsx';
import { StatsPanel } from './ui/stats-panel.tsx';
import { Viewer } from './viewer.ts';

const PACKAGE_PARAM = 'package';

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const App = () => {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [viewer, setViewer] = useState<Viewer | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [current, setCurrent] = useState<OpenPackage | null>(null);
	const [status, setStatus] = useState('');

	const open = (target: Viewer, source: PackageSource, param: string | null): void => {
		const url = new URL(location.href);
		if (param === null) {
			url.searchParams.delete(PACKAGE_PARAM);
		} else {
			url.searchParams.set(PACKAGE_PARAM, param);
		}
		history.replaceState(null, '', url);
		setStatus('opening…');
		setCurrent({ label: source.label, param });
		target
			.load(source, setStatus)
			.then(() => setStatus(''))
			.catch((err: unknown) => {
				setCurrent(null);
				setStatus(`couldn't open ${source.label}: ${describeError(err)}`);
			});
	};
	const openInitial = useEffectEvent((instance: Viewer, param: string) =>
		open(instance, sourceFromParam(param), param),
	);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (canvas === null) {
			return;
		}
		let disposed = false;
		let created: Viewer | null = null;
		Viewer.create(canvas, (reason) => setError(`the GPU device was lost: ${reason}`))
			.then((instance) => {
				if (disposed) {
					instance.destroy();
					return;
				}
				created = instance;
				if (import.meta.env.DEV) {
					// exposed for debugging and automated measurements
					Object.assign(window, { viewer: instance });
				}
				setViewer(instance);
				const param = new URL(location.href).searchParams.get(PACKAGE_PARAM);
				if (param !== null) {
					openInitial(instance, param);
				}
			})
			.catch((err: unknown) => setError(describeError(err)));
		return () => {
			disposed = true;
			created?.destroy();
		};
	}, []);

	return (
		<main className="app">
			<canvas ref={canvasRef} className="viewport" />
			{error !== null && (
				<div className="panel error" role="alert">
					<h2>can't start the viewer</h2>
					<p>{error}</p>
				</div>
			)}
			{viewer !== null && (
				<>
					<div className="dock left">
						<PackagePanel
							current={current}
							status={status}
							onOpen={(source, param) => open(viewer, source, param)}
						/>
						<StatsPanel viewer={viewer} />
					</div>
					<div className="dock right">
						<AreasPanel viewer={viewer} />
						<SettingsPanel viewer={viewer} />
					</div>
					<div className="dock bottom">
						<CameraReadout viewer={viewer} />
					</div>
				</>
			)}
		</main>
	);
};
