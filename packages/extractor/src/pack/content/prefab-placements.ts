import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	multiplyMatrices,
	transformBounds,
	transformPoint,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import {
	ChainFlags,
	type ChainDraw,
	DrawRole,
	type RowPath,
} from '@endfield-noclip/package-format/instances';

import { mapDefined } from '@mary-ext/array-fns';

import { compareNumbers } from '../../compare.ts';
import { formatErrorOnly } from '../../errors.ts';
import {
	type AssetResolver,
	type LocatedObject,
	locatedObject,
	type ObjectRef,
	recordBundleReads,
} from '../../game/assets/assets.ts';
import { RENDER_PIPELINE_QUAD_PATH } from '../../game/assets/builtin-resources.ts';
import { gridIdReach } from '../../game/dynamic/dynamic-grids.ts';
import type { StructureModel } from '../../game/dynamic/dynamic-structures.ts';
import { proxyLevelReaches } from '../../game/dynamic/proxy-reach.ts';
import { axisLengths, withAxisLengths } from '../../game/effects/particle-mesh.ts';
import { billboardPlacement } from '../../game/prefabs/billboard.ts';
import { placePrefabLight, readPrefabLights, type PrefabLight } from '../../game/prefabs/prefab-lights.ts';
import type { PrefabRoots } from '../../game/prefabs/prefab-root.ts';
import { type EffectLodSource, readPrefabRenderers, type PrefabRenderer } from '../../game/prefabs/prefab.ts';
import type { WorldIndex } from '../../game/world/world-index.ts';
import { mapPool } from '../../pool.ts';
import type { BundleSource } from '../convert/convert-pool.ts';
import { chainDistanceOrigin } from '../instances/chains.ts';
import {
	bundleSources,
	relocateSaved,
	type SavedLocator,
	saveLocated,
	sourcesCurrent,
} from '../store/bundle-memo.ts';
import type { PackCache } from '../store/pack-cache.ts';

import { onPivot } from './interactives.ts';
import {
	chainDraw,
	DECAL_CUBE_PATH,
	decalPlacement,
	FLT_MAX,
	type PackContent,
	type RowOwner,
} from './pack-content.ts';

// every prefab the scene places, whatever placed it (dynamic structures, facilities, cabins): its lights and
// renderers, once per prefab and pose, then placed per placement. a prefab that can't be read stands in as a
// box rather than failing the scene (docs/extraction/prefabs-and-interactives.md)

/** unique prefabs decoded concurrently while prefetching */
const PREFAB_CONCURRENCY = 16;

const PREFAB_RENDERERS_ENTRY = new URL('../../game/prefabs/prefab.ts', import.meta.url);
const PREFAB_LIGHTS_ENTRY = new URL('../../game/prefabs/prefab-lights.ts', import.meta.url);

/** a {@link PrefabRenderer} whose mesh and material refs are located without holding bundles open */
type LocatedPrefabRenderer = Omit<PrefabRenderer, 'mesh' | 'materials'> & {
	mesh: LocatedObject | null;
	materials: (LocatedObject | null)[];
};

type SavedPrefabRenderer = Omit<PrefabRenderer, 'mesh' | 'materials'> & {
	mesh: SavedLocator | null;
	materials: (SavedLocator | null)[];
};

interface PrefabRenderersMemo {
	label: string;
	sources: BundleSource[];
	renderers: SavedPrefabRenderer[];
}

interface PrefabLightsMemo {
	label: string;
	sources: BundleSource[];
	lights: PrefabLight[];
}

const relocateRenderers = (
	manifest: AssetResolver['manifest'],
	saved: readonly SavedPrefabRenderer[],
): LocatedPrefabRenderer[] | undefined => {
	const out: LocatedPrefabRenderer[] = [];
	for (const renderer of saved) {
		let mesh: LocatedObject | null = null;
		if (renderer.mesh !== null) {
			const relocated = relocateSaved(manifest, renderer.mesh);
			if (relocated === undefined) {
				return undefined;
			}
			mesh = relocated;
		}
		const materials: (LocatedObject | null)[] = [];
		for (const material of renderer.materials) {
			if (material === null) {
				materials.push(null);
			} else {
				const relocated = relocateSaved(manifest, material);
				if (relocated === undefined) {
					return undefined;
				}
				materials.push(relocated);
			}
		}
		out.push({ ...renderer, mesh, materials });
	}
	return out;
};

/**
 * places the lights and renderers of every placed prefab. a prefab's lights take their synthetic ids before
 * its renderers, placement by placement, so ids follow placement order
 *
 * @param world the world index, to find the particle quad
 * @param roots the placed prefabs' roots, shared with the pack's other prefab readers
 * @param content the pack's content; rows, lights, stand-ins and unsupported prefabs are added
 * @param placements every placed prefab, in placement order
 * @param floaterVolume by floating interactive's level logic id, its water volume's id
 * @param cache optional pack cache for per-prefab renderers and lights
 */
export const placePrefabs = async (
	world: WorldIndex,
	roots: PrefabRoots,
	content: PackContent,
	placements: readonly StructureModel[],
	floaterVolume: ReadonlyMap<string, string>,
	cache: PackCache | null = null,
): Promise<void> => {
	const { scene } = content;
	const { subset } = scene;
	const { resolver } = roots;
	const [renderersFp, lightsFp] =
		cache === null
			? [null, null]
			: await Promise.all([
					cache.fingerprint(PREFAB_RENDERERS_ENTRY),
					cache.fingerprint(PREFAB_LIGHTS_ENTRY),
				]);
	// particleQuad and decalCube are only needed on a prefab renderer cache miss
	let builtinsPromise: Promise<[ObjectRef | null, ObjectRef | null]> | undefined;
	const loadBuiltins = (): Promise<[ObjectRef | null, ObjectRef | null]> =>
		(builtinsPromise ??= Promise.all([
			findMesh(world, resolver, RENDER_PIPELINE_QUAD_PATH),
			findMesh(world, resolver, DECAL_CUBE_PATH),
		]));
	content.count('prefabLights', 0);

	// filter placements first, then prefetch every unique prefab and its lights concurrently while committing
	// results, stand-ins and unsupported reports in placement order below
	interface PrefabWork {
		key: string;
		pathHash: bigint;
		pose: StructureModel['pose'];
		locked: boolean;
		effectLod: EffectLodSource;
	}
	const activePlacements: { placement: StructureModel; key: string }[] = [];
	const uniqueWork = new Map<string, PrefabWork>();
	const uniqueHashes = new Set<bigint>();
	for (const placement of placements) {
		const { model, levelTag, pose } = placement;
		// ownership filters can reject a prefab before any of its bundles are read
		if (scene.level !== null && !subset.includesPoint(levelTag, model.position)) {
			continue;
		}
		// a pose that switches the root off leaves nothing to draw, light or report
		if (pose?.hidden === true) {
			continue;
		}
		const locked = placement.locked ?? false;
		// dynamic scene effects have their LOD band set by a LOD proxy; dynamic scene models are plain
		// prefabs whose nested EffectSettings are never initialized or ticked; interactives drive theirs by
		// camera distance (docs/game-data/effects.md#effect-lod-tables)
		let effectLod: EffectLodSource;
		if (placement.lodGrids !== undefined) {
			effectLod = 'proxy';
		} else if (placement.grid !== undefined) {
			effectLod = 'none';
		} else {
			effectLod = 'camera';
		}
		const key = `${model.pathHash}:${pose?.key ?? ''}:${locked}:${effectLod}`;
		activePlacements.push({ placement, key });
		uniqueHashes.add(model.pathHash);
		if (!uniqueWork.has(key)) {
			uniqueWork.set(key, { key, pathHash: model.pathHash, pose, locked, effectLod });
		}
	}

	const hashList = [...uniqueHashes];
	const lightsList = await mapPool(hashList, PREFAB_CONCURRENCY, async (hash) => {
		const memoKey =
			cache === null || lightsFp === null ? null : cache.keyWith(lightsFp, { kind: 'prefabLights', hash });
		if (memoKey !== null) {
			const recalled = await cache!.recallValue<PrefabLightsMemo>(memoKey);
			if (recalled !== undefined && (await sourcesCurrent(resolver, recalled.sources))) {
				return { label: recalled.label, lights: recalled.lights, error: null as FormatError | null };
			}
		}
		const { result: loaded, bundles } = await recordBundleReads(async () => {
			const { label, root } = await roots.root(hash);
			if (root instanceof FormatError) {
				return { label, lights: [] as PrefabLight[], error: null as FormatError | null, cacheable: false };
			}
			const lights = await readPrefabLights(resolver, root).catch(formatErrorOnly);
			if (lights instanceof FormatError) {
				return { label, lights: [] as PrefabLight[], error: lights, cacheable: false };
			}
			return { label, lights, error: null as FormatError | null, cacheable: true };
		});
		if (memoKey !== null && loaded.cacheable) {
			await cache!.rememberValue(memoKey, {
				label: loaded.label,
				sources: await bundleSources(resolver, bundles),
				lights: loaded.lights,
			} satisfies PrefabLightsMemo);
		}
		return loaded;
	});
	const prefabLights = new Map(hashList.map((hash, i) => [hash, lightsList[i]]));

	const workList = [...uniqueWork.values()];
	const renderersList = await mapPool(workList, PREFAB_CONCURRENCY, async (work) => {
		const memoKey =
			cache === null || renderersFp === null
				? null
				: cache.keyWith(renderersFp, {
						kind: 'prefabRenderers',
						pathHash: work.pathHash,
						pose: work.pose,
						locked: work.locked,
						effectLod: work.effectLod,
					});
		if (memoKey !== null) {
			const recalled = await cache!.recallValue<PrefabRenderersMemo>(memoKey);
			if (recalled !== undefined && (await sourcesCurrent(resolver, recalled.sources))) {
				const relocated = relocateRenderers(resolver.manifest, recalled.renderers);
				if (relocated !== undefined) {
					return { label: recalled.label, read: relocated as LocatedPrefabRenderer[] | FormatError };
				}
			}
		}
		const [particleQuad, decalCube] = await loadBuiltins();
		const { result: loaded, bundles } = await recordBundleReads(async () => {
			const { label, root } = await roots.root(work.pathHash);
			if (root instanceof FormatError) {
				return { label, read: root as PrefabRenderer[] | FormatError };
			}
			const read = await readPrefabRenderers(resolver, root, {
				viewPose: work.pose,
				particleQuad,
				decalCube,
				locked: work.locked,
				effectLod: work.effectLod,
			}).catch(formatErrorOnly);
			return { label, read };
		});
		if (loaded.read instanceof FormatError) {
			return { label: loaded.label, read: loaded.read as LocatedPrefabRenderer[] | FormatError };
		}
		const located: LocatedPrefabRenderer[] = loaded.read.map((renderer) => ({
			...renderer,
			mesh: renderer.mesh === null ? null : locatedObject(renderer.mesh),
			materials: renderer.materials.map((material) => (material === null ? null : locatedObject(material))),
		}));
		if (memoKey !== null) {
			const extraBundles = new Set(bundles);
			if (particleQuad !== null) {
				extraBundles.add(particleQuad.bundleIndex);
			}
			if (decalCube !== null) {
				extraBundles.add(decalCube.bundleIndex);
			}
			await cache!.rememberValue(memoKey, {
				label: loaded.label,
				sources: await bundleSources(
					resolver,
					// oxlint-disable-next-line unicorn/no-array-sort -- sorts a fresh copy
					[...extraBundles].sort(compareNumbers),
				),
				renderers: located.map((renderer) => ({
					...renderer,
					mesh: renderer.mesh === null ? null : saveLocated(resolver.manifest, renderer.mesh),
					materials: renderer.materials.map((material) =>
						material === null ? null : saveLocated(resolver.manifest, material),
					),
				})),
			} satisfies PrefabRenderersMemo);
		}
		return { label: loaded.label, read: located as LocatedPrefabRenderer[] | FormatError };
	});
	const prefabs = new Map(workList.map((work, i) => [work.key, renderersList[i]]));

	const reportedPrefabs = new Set<string>();
	const reportedLightErrors = new Set<bigint>();
	for (const { placement, key } of activePlacements) {
		const { model, levelTag, lodGrids } = placement;
		const rotation = unityEulerQuaternion(model.rotation);
		const lightEntry = prefabLights.get(model.pathHash)!;
		if (lightEntry.error !== null && !reportedLightErrors.has(model.pathHash)) {
			reportedLightErrors.add(model.pathHash);
			content.unsupportedPrefab({ path: lightEntry.label, reason: lightEntry.error.message });
		}
		for (const prefabLight of lightEntry.lights) {
			const light = placePrefabLight(
				prefabLight,
				{ position: model.position, rotation, scale: model.scale },
				content.nextSyntheticId(levelTag),
			);
			if (content.addLight(light, placement.visibility)) {
				content.count('prefabLights');
			}
		}
		const rootMatrix = trsMatrix(model.position, rotation, model.scale);
		const owner = {
			tag: levelTag,
			visibility: placement.visibility,
			loadReach: placement.grid === undefined ? null : gridIdReach(placement.grid),
		};
		const { label, read } = prefabs.get(key)!;
		if (!reportedPrefabs.has(key)) {
			reportedPrefabs.add(key);
			if (read instanceof FormatError) {
				content.unsupportedPrefab({ path: label, reason: read.message });
			} else {
				for (const { name, unsupported } of read) {
					if (unsupported !== null) {
						content.standIns.push({ path: label, name, reason: unsupported, position: null });
					}
				}
			}
		}
		if (read instanceof FormatError) {
			// its size isn't known, so a metre cube stands on its pivot, scaled with the placement
			content.addStandInCube(
				{ ...owner, matrix: onPivot(rootMatrix) },
				{ path: label, name: label, reason: read.message },
			);
			continue;
		}
		const { ride } = placement;
		// a spline sets a riding placement's height, so it doesn't float as well
		const floatsOn =
			ride !== undefined || placement.logicId === undefined
				? undefined
				: floaterVolume.get(placement.logicId);
		for (const renderer of read) {
			const { proxyLevels } = renderer;
			if (proxyLevels === null || lodGrids === undefined || placement.grid === undefined) {
				placeRenderer(content, renderer, { rootMatrix, owner, floatsOn, ride });
				continue;
			}
			// a renderer shown at some proxy levels draws where the streaming centre puts the proxy at them
			for (const loadReach of proxyLevelReaches(placement.grid, lodGrids, proxyLevels)) {
				placeRenderer(content, renderer, { rootMatrix, owner: { ...owner, loadReach }, floatsOn, ride });
			}
		}
	}
};

/** places one renderer of a placed prefab */
const placeRenderer = (
	content: PackContent,
	renderer: LocatedPrefabRenderer,
	{
		rootMatrix,
		owner,
		floatsOn,
		ride,
	}: {
		/** the placement's transform */
		rootMatrix: Float32Array;
		owner: Omit<RowOwner, 'name'>;
		/** the id of the water volume the placement floats on */
		floatsOn: string | undefined;
		/** the path the placement rides */
		ride: RowPath | undefined;
	},
): void => {
	let matrix = multiplyMatrices(rootMatrix, renderer.matrix);
	if (renderer.ownSize) {
		matrix = withAxisLengths(matrix, axisLengths(renderer.matrix));
	}
	let bounds = transformBounds(renderer.bounds, matrix);
	if (renderer.billboard !== null && renderer.billboard.flag !== ChainFlags.BillboardAxial) {
		({ matrix, bounds } = billboardPlacement(
			matrix,
			multiplyMatrices(rootMatrix, renderer.billboard.frame),
			renderer.billboard.offset,
			renderer.bounds,
		));
	}
	if (!content.scene.subset.includesPoint(owner.tag, bounds.center)) {
		return;
	}
	const draws = rendererDraws(content, renderer);
	if (draws.length === 0) {
		return;
	}
	const entityId = content.nextSyntheticId(owner.tag);
	let lodGroup: [number, number, number, number] | undefined;
	if (renderer.distances === null && renderer.lodGroup != null) {
		const center = transformPoint(rootMatrix, renderer.lodGroup.center);
		const scale = Math.max(...axisLengths(rootMatrix));
		if (scale > 0) {
			lodGroup = [center[0], center[1], center[2], renderer.lodGroup.size * scale];
		}
	}
	content.addStructure(
		{
			chain: content.chains.intern(draws, {
				billboard: renderer.billboard?.flag ?? 0,
				distanceOrigin:
					renderer.distances === null
						? null
						: chainDistanceOrigin(matrix, transformPoint(rootMatrix, renderer.distances.origin)),
			}),
			matrix,
			bounds,
			entityId,
			floatsOn,
			ride,
			...(lodGroup !== undefined ? { lodGroup } : {}),
			...(renderer.decal === null ? {} : { decalPlacement: decalPlacement(renderer.decal) }),
		},
		{ ...owner, name: renderer.name },
	);
};

/** @returns a prefab renderer's draws: one per material and LOD span */
const rendererDraws = (content: PackContent, renderer: LocatedPrefabRenderer): ChainDraw[] => {
	let geometry: number;
	if (renderer.synthetic !== null) {
		geometry = content.geometries.internSynthetic(renderer.synthetic.mesh);
	} else if (renderer.decal !== null) {
		// shared with the world's rect decals, which intern the cube by its path
		const cube = content.decalCube();
		if (cube === null) {
			return [];
		}
		geometry = cube;
	} else if (renderer.motion !== null) {
		geometry = content.geometries.internAnimatedObject(renderer.mesh!, renderer.motion);
	} else if (renderer.pose !== null) {
		geometry = content.geometries.internPosedObject(renderer.mesh!, renderer.pose);
	} else {
		geometry = content.geometries.internObject(renderer.mesh!);
	}
	let role: DrawRole = DrawRole.Lit;
	if (renderer.unsupported !== null) {
		role = DrawRole.Unsupported;
	} else if (renderer.shadowOnly) {
		role = DrawRole.ShadowOnly;
	}
	// an effect's LOD table shows the renderer at some camera distances from the effect's origin, or a LODGroup
	// at some screen-relative heights: one draw per span. distance bands win where both apply
	let spans: { lod: number; minSquared: number; maxSquared: number }[];
	if (renderer.distances === null && renderer.sizes !== null) {
		spans = renderer.sizes.map(({ lod, min, max }) => squaredSpan(lod, min, max));
	} else {
		const ranges = renderer.distances?.ranges ?? [{ near: 0, far: Infinity }];
		spans = ranges.map(({ near, far }) => squaredSpan(0, near, far));
	}
	return mapDefined(renderer.materials, (material, index): ChainDraw[] | undefined => {
		if (material === null) {
			return undefined;
		}
		const particles = renderer.particles === null ? null : content.particles.intern(renderer.particles);
		// a pose's clips can set this renderer's material values, which then need a variant of their own
		const saved = renderer.materialValues[index];
		let id: number;
		if (saved === null) {
			id = content.materials.internObject(material);
		} else {
			id = content.materials.internObjectVariant(material, `posed ${JSON.stringify(saved)}`);
			content.materialOverrides.set(id, { saved, waterDecal: null });
		}
		// a prefab renderer has no game flag word; its role says whether it only casts shadows
		return spans.map((span) =>
			chainDraw({
				geometry,
				material: id,
				particles,
				submesh: Math.min(index, renderer.submeshes - 1),
				role,
				sortingLayer: renderer.sorting.layer,
				sortingOrder: renderer.sorting.order,
				...span,
			}),
		);
	}).flat();
};

/** a threshold span as squared bounds: an empty lower bound never culls, an infinite upper is `FLT_MAX` */
const squaredSpan = (
	lod: number,
	min: number,
	max: number,
): { lod: number; minSquared: number; maxSquared: number } => ({
	lod,
	minSquared: min > 0 ? min * min : -1,
	maxSquared: Number.isFinite(max) ? max * max : FLT_MAX,
});

/**
 * @returns the mesh at a path (the quad billboard particles draw, the decal cube), or `null` if the install
 *   doesn't have it where expected
 */
const findMesh = async (
	world: WorldIndex,
	resolver: AssetResolver,
	path: string,
): Promise<ObjectRef | null> => {
	const [hash] = await world.hashesOf(path);
	if (hash === undefined) {
		return null;
	}
	try {
		return await resolver.findUnique({ hash, path }, UnityClass.Mesh);
	} catch {
		return null;
	}
};
