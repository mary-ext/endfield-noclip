import { useEffect, useEffectEvent, useRef, useState } from 'react';

import type { PackageSource } from './package/package-source.ts';
import { CameraReadout } from './ui/camera-readout.tsx';
import { LevelsPanel } from './ui/levels-panel.tsx';
import { type OpenPackage, PackagePanel } from './ui/package-panel.tsx';
import { sourceFromParam } from './ui/package-param.ts';
import { SceneControls } from './ui/scene-controls.tsx';
import { SettingsPanel } from './ui/settings-panel.tsx';
import { StatsPanel } from './ui/stats-panel.tsx';
import { Viewer } from './viewer.ts';

const PACKAGE_PARAM = 'package';
const LEVEL_PARAM = 'level';

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** sets or clears a search parameter of the page URL without a navigation */
const setParam = (name: string, value: string | null): void => {
	const url = new URL(location.href);
	if (value === null) {
		url.searchParams.delete(name);
	} else {
		url.searchParams.set(name, value);
	}
	history.replaceState(null, '', url);
};

export const App = () => {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const [viewer, setViewer] = useState<Viewer | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [current, setCurrent] = useState<OpenPackage | null>(null);
	const [status, setStatus] = useState('');

	const open = (target: Viewer, source: PackageSource, param: string | null): void => {
		setParam(PACKAGE_PARAM, param);
		setStatus('opening…');
		setCurrent({ label: source.label, param });
		target
			.load(source, new URL(location.href).searchParams.get(LEVEL_PARAM), setStatus)
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

	// the shown level lives in the URL, so a reload or a shared link opens the same level
	useEffect(() => {
		if (viewer === null) {
			return;
		}
		return viewer.subscribe(() => {
			// nothing to record while no package is loaded (including mid-load)
			if (viewer.scene !== null && new URL(location.href).searchParams.get(LEVEL_PARAM) !== viewer.level) {
				setParam(LEVEL_PARAM, viewer.level);
			}
		});
	}, [viewer]);

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
						<LevelsPanel viewer={viewer} />
						<SceneControls viewer={viewer} />
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
