import { decodeBlobTable, type BlobRecord } from '@endfield-noclip/package-format/blob-table';
import {
	type ResolvedEnvironmentTable,
	type EnvironmentTable,
	resolveEnvironment,
} from '@endfield-noclip/package-format/environment';
import { decodeGeometryTable, type GeometryTable } from '@endfield-noclip/package-format/geometry-table';
import { decodeChains, type Chain } from '@endfield-noclip/package-format/instances';
import { decodeIrradianceTable, type IrradianceTable } from '@endfield-noclip/package-format/irradiance';
import type { LightsTable } from '@endfield-noclip/package-format/lights';
import {
	CORE_ARCHIVE,
	CORE_ARCHIVE_INDEX,
	CORE_PATHS,
	PACKAGE_FORMAT,
	PACKAGE_VERSION,
	type PackageManifest,
} from '@endfield-noclip/package-format/manifest';
import type { MaterialTable } from '@endfield-noclip/package-format/materials';
import type { ParticlesTable } from '@endfield-noclip/package-format/particles';
import { decodeTextureTable, type TextureTable } from '@endfield-noclip/package-format/texture-table';
import { decodeTree, type Tree } from '@endfield-noclip/package-format/tree';
import type { WaterTable } from '@endfield-noclip/package-format/water';

import { fromUint8Array, openArchive } from '@mary-ext/czar';

import type { PackageSource } from './package-source.ts';
import { decompressZstd, zstdReady } from './zstd.ts';

/** a blob's absolute byte range in its shard archive */
export interface BlobRange {
	archive: number;
	path: string;
	start: number;
	length: number;
	/** the archive's size, which a read checks to notice a re-packed package */
	archiveSize: number;
}

/** everything the viewer reads from the core archive up front */
export interface ViewerPackage {
	source: PackageSource;
	manifest: PackageManifest;
	tree: Tree;
	blobs: BlobRecord[];
	chains: Chain[];
	geometries: GeometryTable;
	materials: MaterialTable;
	textures: TextureTable;
	/** the scene's water */
	water: WaterTable;
	/** the scene's local lights */
	lights: LightsTable;
	/** the particle systems chain draws emit */
	particles: ParticlesTable;
	/** the environment volumes and their phases, the phases' sections looked up */
	environment: ResolvedEnvironmentTable;
	/** the baked irradiance volume's cells (empty without one) */
	irradiance: IrradianceTable;
	/**
	 * @param index index of a blob in the core archive
	 * @returns the blob's stored bytes (codec not undone), in a buffer of their own
	 */
	readCoreBlob(index: number): Promise<ArrayBuffer>;
	/**
	 * @param index index of a blob outside the core archive
	 * @returns the archive path and absolute byte range of the blob, for request coalescing
	 * @throws {PackageError} for a core blob
	 */
	blobRange(index: number): BlobRange;
}

/** thrown for a package this viewer can't read */
export class PackageError extends Error {
	override name = 'PackageError';
}

/**
 * reads and validates the core archive and decodes its tables.
 *
 * @param source where the package lives
 * @param onProgress reports phases for the UI
 * @returns the opened package
 * @throws {PackageError} on a wrong format or version
 */
export const openViewerPackage = async (
	source: PackageSource,
	onProgress: (phase: string) => void,
): Promise<ViewerPackage> => {
	onProgress(`reading ${CORE_ARCHIVE}`);
	const core = await source.readFile(CORE_ARCHIVE);
	const archive = await openArchive(fromUint8Array(core));
	// the first member sits at the start of the data section, which core blob offsets are relative to
	const coreData = archive.files[0]?.position ?? 0;

	onProgress('decoding tables');
	await zstdReady;
	const member = async (path: string): Promise<Uint8Array> => {
		const file = archive.get(path);
		if (file === undefined) {
			throw new PackageError(`${CORE_ARCHIVE} has no ${path}`);
		}
		const bytes = await file.bytes();
		// `.zst` members are a single zstd frame
		return path.endsWith('.zst') ? decompressZstd(bytes) : bytes;
	};
	const json = async (path: string): Promise<unknown> =>
		JSON.parse(new TextDecoder().decode(await member(path)));

	const manifestValue = await json(CORE_PATHS.manifest);
	if (
		typeof manifestValue !== 'object' ||
		manifestValue === null ||
		!('format' in manifestValue) ||
		manifestValue.format !== PACKAGE_FORMAT
	) {
		throw new PackageError(`not an endfield-noclip package`);
	}
	if (!('version' in manifestValue) || manifestValue.version !== PACKAGE_VERSION) {
		const version = 'version' in manifestValue ? String(manifestValue.version) : 'unknown';
		throw new PackageError(`package version ${version} isn't supported (expected ${PACKAGE_VERSION})`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- format and version checked above
	const manifest = manifestValue as PackageManifest;
	const tree = decodeTree(await member(CORE_PATHS.tree));
	const blobs = decodeBlobTable(await member(CORE_PATHS.blobs));
	const chains = decodeChains(await member(CORE_PATHS.chains));
	const geometries = decodeGeometryTable(await member(CORE_PATHS.geometries));
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const materials = (await json(CORE_PATHS.materials)) as MaterialTable;
	const textures = decodeTextureTable(await member(CORE_PATHS.textures));
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const water = (await json(CORE_PATHS.water)) as WaterTable;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const lights = (await json(CORE_PATHS.lights)) as LightsTable;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const particles = (await json(CORE_PATHS.particles)) as ParticlesTable;
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same package version as the manifest
	const environment = resolveEnvironment((await json(CORE_PATHS.environment)) as EnvironmentTable);
	const irradiance = decodeIrradianceTable(await member(CORE_PATHS.irradiance));

	return {
		source,
		manifest,
		tree,
		blobs,
		chains,
		geometries,
		materials,
		textures,
		water,
		lights,
		particles,
		environment,
		irradiance,
		readCoreBlob(index) {
			const blob = blobs[index];
			const start = coreData + blob.offset;
			if (blob.archive !== CORE_ARCHIVE_INDEX || start + blob.length > core.length) {
				return Promise.reject(new PackageError(`blob ${index} isn't in ${CORE_ARCHIVE}`));
			}
			// copied out of the archive buffer, so it can be transferred to a worker
			return Promise.resolve(core.slice(start, start + blob.length).buffer);
		},
		blobRange(index) {
			const blob = blobs[index];
			const info = manifest.archives[blob.archive];
			if (info.role === 'core') {
				throw new PackageError(`blob ${index} is in ${CORE_ARCHIVE}, which is read whole`);
			}
			return {
				archive: blob.archive,
				path: info.name,
				start: info.dataOffset + blob.offset,
				length: blob.length,
				archiveSize: info.size,
			};
		},
	};
};
