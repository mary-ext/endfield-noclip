import { useEffect, useId, useRef, useState } from 'react';

import { DEV_PACKAGES_INDEX, DEV_PACKAGES_PREFIX, type DevPackage } from '../package/dev-packages.ts';
import {
	type PackageSource,
	directorySource,
	fileListSource,
	importToOpfs,
	listOpfsPackages,
	openOpfsPackage,
} from '../package/package-source.ts';

import { formatBytes } from './format.ts';
import { sourceFromParam } from './package-param.ts';

/** the open package: its source's label, and its `?package=` value if it has one */
export interface OpenPackage {
	label: string;
	param: string | null;
}

const fetchDevPackages = async (): Promise<DevPackage[]> => {
	const response = await fetch(`${DEV_PACKAGES_PREFIX}${DEV_PACKAGES_INDEX}`);
	if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
		return [];
	}
	const body: unknown = await response.json();
	if (typeof body !== 'object' || body === null || !('packages' in body) || !Array.isArray(body.packages)) {
		return [];
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- our own dev endpoint
	return body.packages as DevPackage[];
};

/** chooses a package: dev-server packages, a local folder, or one imported into OPFS */
export const PackagePanel = ({
	current,
	status,
	onOpen,
}: {
	current: OpenPackage | null;
	status: string;
	onOpen: (source: PackageSource, param: string | null) => void;
}) => {
	const [devPackages, setDevPackages] = useState<DevPackage[]>([]);
	const [opfsPackages, setOpfsPackages] = useState<string[]>([]);
	const [copyToOpfs, setCopyToOpfs] = useState(false);
	const [importing, setImporting] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const copyId = useId();

	useEffect(() => {
		fetchDevPackages()
			.then(setDevPackages)
			.catch(() => setDevPackages([]));
		listOpfsPackages()
			.then(setOpfsPackages)
			.catch(() => setOpfsPackages([]));
	}, []);

	const openFolder = async (): Promise<void> => {
		if (window.showDirectoryPicker === undefined) {
			inputRef.current?.click();
			return;
		}
		let handle: FileSystemDirectoryHandle;
		try {
			handle = await window.showDirectoryPicker({ id: 'endfield-noclip-package', mode: 'read' });
		} catch {
			// cancelled
			return;
		}
		if (!copyToOpfs) {
			onOpen(directorySource(handle), null);
			return;
		}
		setImporting(handle.name);
		try {
			const name = await importToOpfs(handle, (bytes) =>
				setImporting(`${handle.name}: ${formatBytes(bytes)}`),
			);
			setOpfsPackages(await listOpfsPackages());
			onOpen(directorySource(await openOpfsPackage(name)), null);
		} finally {
			setImporting(null);
		}
	};

	return (
		<section className="panel package" aria-label="package">
			<header>
				<h2>package</h2>
				<span className="muted small">{current?.label ?? 'none'}</span>
			</header>
			{devPackages.length > 0 && (
				<ul className="choices">
					{devPackages.map((pkg) => (
						<li key={pkg.name}>
							<button
								type="button"
								aria-pressed={current?.param === pkg.name}
								onClick={() => onOpen(sourceFromParam(pkg.name), pkg.name)}
							>
								{pkg.name} <span className="muted small">core {formatBytes(pkg.coreSize)}</span>
							</button>
						</li>
					))}
				</ul>
			)}
			{opfsPackages.length > 0 && (
				<ul className="choices">
					{opfsPackages.map((name) => (
						<li key={name}>
							<button
								type="button"
								onClick={() => {
									openOpfsPackage(name)
										.then((handle) => onOpen(directorySource(handle), null))
										.catch((err: unknown) => console.error(err));
								}}
							>
								{name} <span className="muted small">browser storage</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<div className="row">
				<button type="button" onClick={() => void openFolder()} disabled={importing !== null}>
					open folder…
				</button>
				{window.showDirectoryPicker !== undefined && navigator.storage?.getDirectory !== undefined && (
					<label className="toggle small" htmlFor={copyId}>
						<input
							id={copyId}
							type="checkbox"
							checked={copyToOpfs}
							onChange={(event) => setCopyToOpfs(event.currentTarget.checked)}
						/>
						copy into browser storage
					</label>
				)}
			</div>
			<input
				ref={inputRef}
				type="file"
				hidden
				// @ts-expect-error -- non-standard but universally supported directory selection
				webkitdirectory=""
				onChange={(event) => {
					const files = event.currentTarget.files;
					if (files !== null && files.length > 0) {
						onOpen(fileListSource(files), null);
					}
				}}
			/>
			{(importing !== null || status !== '') && <p className="muted small">{importing ?? status}</p>}
		</section>
	);
};
