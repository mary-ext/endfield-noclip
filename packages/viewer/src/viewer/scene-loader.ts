import { markBillboardRows } from '../content/instance-rows.ts';
import { instanceRowKinds } from '../content/row-kinds.ts';
import type { EnvironmentScene } from '../environment/blend.ts';
import { LazyMaterialLooks } from '../looks/material-looks.ts';
import type { DecodePool } from '../package/decode-pool.ts';
import type { ViewerPackage } from '../package/viewer-package.ts';
import { ParticleField } from '../particles/particle-rows.ts';
import type { InstanceRenderer } from '../render/instances/instance-renderer.ts';
import type { IrradianceVolume } from '../render/lighting/irradiance-volume.ts';
import type { MeshRenderer } from '../render/meshes/mesh-renderer.ts';
import type { TerrainRenderer } from '../render/terrain/terrain-renderer.ts';
import { TextureStore } from '../render/textures/texture-store.ts';
import type { WaterLevels } from '../scene-states/water-levels.ts';
import type { GroundSource } from '../scene/ground.ts';
import { type TileTree, buildTileTree } from '../scene/tile-tree.ts';
import { coreBlobs, terrainLayerBlobs } from '../streaming/core-blobs.ts';
import { MeshSelector } from '../streaming/mesh-selection.ts';
import { Selector } from '../streaming/selection.ts';
import { StreamManager } from '../streaming/stream-manager.ts';

/** what the level list needs */
export interface LevelEntry {
	id: string;
	name: string;
	instances: number;
}

/** an open package, streaming into the renderers */
export interface LoadedScene {
	pkg: ViewerPackage;
	tree: TileTree;
	stream: StreamManager;
	/** ground height queries over the resident coarse terrain */
	ground: GroundSource & EnvironmentScene;
	selector: Selector;
	/** per-instance LOD selection, when the package has converted geometry */
	meshes: MeshSelector | null;
	textures: TextureStore;
	/** the package's converted geometries, and how many of them converted */
	geometries: { ready: number; total: number };
	levels: LevelEntry[];
}

/** the long-lived systems a scene streams into */
export interface SceneDeps {
	device: GPUDevice;
	/** whether the device has BC textures */
	bc: boolean;
	pool: DecodePool;
	terrain: TerrainRenderer;
	instances: InstanceRenderer;
	meshes: MeshRenderer;
	/** the volume, already set to the package's (`setPackage`) */
	irradiance: IrradianceVolume;
	/** tracks the instance blocks that water volumes move */
	waterLevels: WaterLevels;
	/** the streamed content budget, bytes */
	budgetBytes: number;
}

/**
 * wires an opened package to the renderers: a texture store, a stream manager whose residency handlers upload
 * into the renderers, the core blobs pinned, and the selectors. the caller destroys the stream and the store
 * when it drops the scene.
 *
 * @param pkg the opened package
 * @param deps the systems it streams into
 * @returns the scene
 */
export const openScene = (pkg: ViewerPackage, deps: SceneDeps): LoadedScene => {
	const { terrain, instances, meshes, irradiance, waterLevels } = deps;
	const manifest = pkg.manifest;
	const tree = buildTileTree(manifest, pkg.tree);
	const textures = new TextureStore(deps.device, pkg.textures, { bc: deps.bc });
	const particles = new ParticleField(pkg.particles, instances);
	const rowKinds = instanceRowKinds(tree, pkg.tree.global);
	let layersPinned = false;
	const stream: StreamManager = new StreamManager(
		pkg,
		deps.pool,
		{
			heights: {
				upload: (_blob, decoded, { pinned }) => terrain.upload(decoded, { keepSamples: pinned }),
				release: (_blob, resident) => terrain.release(resident),
			},
			surface: {
				upload: (_blob, decoded) => terrain.uploadSurface(decoded),
				release: (_blob, resident) => terrain.releaseSurface(resident),
			},
			splat: {
				upload: (_blob, decoded) => {
					if (!layersPinned && terrain.surfaces) {
						layersPinned = true;
						stream.pin(terrainLayerBlobs(pkg));
					}
					return terrain.uploadSplat(decoded);
				},
				release: (_blob, resident) => terrain.releaseSplat(resident),
			},
			layer: {
				upload: (blob, decoded) => terrain.uploadLayer(blob, decoded),
				// pinned for the package's lifetime; its array goes with the next `setSplat`
				release: () => {},
			},
			instances: {
				job: (blob, stored) => ({ kind: 'instances', ...stored, rowKinds: rowKinds.get(blob) ?? [] }),
				upload: (_blob, decoded) => {
					// the decode worker doesn't hold the chains
					markBillboardRows(decoded, pkg.chains);
					const resident = instances.upload(decoded);
					if (resident !== null) {
						waterLevels.track(resident);
					}
					return resident;
				},
				release: (_blob, resident) => {
					particles.release(resident);
					waterLevels.untrack(resident);
					instances.release(resident);
				},
			},
			geometry: {
				upload: (blob, decoded) => meshes.upload(blob, decoded),
				release: (_blob, resident) => meshes.release(resident),
			},
			texture: {
				upload: (blob, decoded) => textures.upload(blob, decoded),
				release: (blob) => textures.release(blob),
			},
			irradiance: {
				upload: (_blob, decoded) => irradiance.upload(decoded),
				release: (_blob, resident) => irradiance.release(resident),
			},
		},
		{ budgetBytes: deps.budgetBytes, maxRequests: 32, uploadBytesPerFrame: 24 * 2 ** 20 },
	);
	terrain.setSplat(manifest.terrain?.splat ?? null);
	stream.pin(coreBlobs(pkg, { surfaces: terrain.surfaces }));

	const geometries = pkg.geometries;
	let geometriesReady = 0;
	for (let id = 0; id < geometries.count; id++) {
		if (geometries.blob(id) !== null) {
			geometriesReady++;
		}
	}
	return {
		pkg,
		tree,
		stream,
		ground: {
			manifest,
			environment: pkg.environment,
			tree,
			heights: (blob) => {
				const resident = stream.get(blob)?.resident;
				return resident?.kind === 'heights' ? resident.samples : null;
			},
		},
		selector: new Selector(tree, stream, pkg.tree.global, manifest.tree.rootSize),
		meshes:
			geometriesReady > 0
				? new MeshSelector({
						chains: pkg.chains,
						geometries,
						looks: new LazyMaterialLooks(pkg.materials),
						stream,
						textures,
						particles,
					})
				: null,
		textures,
		geometries: { ready: geometriesReady, total: geometries.count },
		levels: manifest.levels.map((level) => ({
			id: level.id,
			name: level.name ?? level.id,
			instances: level.instances,
		})),
	};
};
