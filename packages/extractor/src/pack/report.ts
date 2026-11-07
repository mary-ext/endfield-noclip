import { BLOB_KIND_NAMES } from '@endfield-noclip/package-format/blobs';
import { CONTENT_KIND_NAMES, type Tree } from '@endfield-noclip/package-format/tree';

import type { AssetConversion } from './convert/assets.ts';
import type { HlodLayout } from './instances/hlod-cells.ts';
import type { InstanceCounts } from './instances/instance-blocks.ts';
import type { BlobStore } from './store/blob-store.ts';
import type { CacheReport } from './store/pack-cache.ts';
import type { LevelEnvironmentDebug } from './tables/environments.ts';
import type { IrradianceReport } from './tables/irradiance.ts';
import type { WaterDebug } from './tables/water.ts';
import type { WrittenArchive } from './write.ts';

/** numbers about a written package */
export interface PackReport {
	outDir: string;
	timings: Record<string, number>;
	/** what the entities phase read, packed and left out, by what its sources call each count */
	entities: Record<string, number>;
	instances: InstanceCounts;
	chains: { count: number; draws: number; instancesPerChain: number };
	assets: {
		geometries: number;
		materials: number;
		/** texture-table entries (deduplicated by content) */
		textures: number;
		shaders: number;
		unresolvedPaths: number;
		ready: { geometries: number; materials: number; textures: number };
	};
	/** asset conversion details, or `null` when assets weren't converted */
	conversion: AssetConversion['stats'] | null;
	/**
	 * post profiles, the textures the phases reference, what each level resolved to, and how many inputs were
	 * left out (listed in `debug/environments.json`)
	 */
	environments: { posts: number; textures: number; levels: LevelEnvironmentDebug[]; problems: number };
	/** water surfaces in the scene and packed, configs, the global config's name, sectors and maps */
	water: Pick<WaterDebug, 'surfaces' | 'volumes' | 'global' | 'sectors'> & {
		configs: number;
		textures: number;
		/** assets that failed to load, listed in `debug/water.json` */
		errors: number;
	};
	/**
	 * kept terrain tiles and how many pages were left out (listed in `debug/terrain.json`), `null` without
	 * terrain
	 */
	terrain: {
		tiles: number;
		withoutSurface: number;
		leavesWithoutSplat: number;
		orphanPages: number;
		layerProblem: string | null;
	} | null;
	hlod: {
		clusters: number;
		tierCounts: number[];
		nameMatchesPosition: number;
		/** the grid fitted to cluster names; misaligned tiers' clusters were filed by their detail */
		grid: Omit<HlodLayout, 'levels'>;
	};
	/** the baked irradiance volume's packed cells, or `null` if the scene has none */
	irradiance: IrradianceReport | null;
	tree: { nodes: number; refs: number; byKind: Record<string, number> };
	blobs: Record<string, { count: number; stored: number; raw: number }>;
	/** byte length of each fixed core member (tree, tables, blob index) */
	coreMembers: Record<string, number>;
	/** every archive; `reused` ones were cloned from the package this one replaced */
	archives: WrittenArchive[];
	totalBytes: number;
	/** cache hits and sweep, or `null` without a cache */
	cache: CacheReport | null;
	/** peak resident set size of the process, bytes */
	peakRss: number;
}

/** @returns how many entries converted */
export const ready = (entries: readonly { status: string }[]): number =>
	entries.filter((entry) => entry.status === 'ready').length;

/** @returns the tree's nodes, and its content refs by kind */
export const treeTotals = (tree: Tree): PackReport['tree'] => {
	const byKind: Record<string, number> = {};
	for (const ref of tree.refs) {
		const kind = CONTENT_KIND_NAMES[ref.kind];
		byKind[kind] = (byKind[kind] ?? 0) + 1;
	}
	return { nodes: tree.nodes.length, refs: tree.refs.length, byKind };
};

/** @returns the store's blobs by kind: count, stored and raw bytes */
export const blobTotals = (store: BlobStore): PackReport['blobs'] => {
	const totals: PackReport['blobs'] = {};
	for (const [kind, total] of store.totals()) {
		totals[BLOB_KIND_NAMES[kind]] = total;
	}
	return totals;
};
