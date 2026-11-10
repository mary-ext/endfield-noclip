import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	inverseTransformPoint,
	multiplyMatrices,
	transformBounds,
	transformPoint,
	trsMatrix,
	unityEulerQuaternion,
} from '@endfield-noclip/formats/unity/transform';
import { type ChainDraw, DrawRole } from '@endfield-noclip/package-format/instances';

import { mapDefined } from '@mary-ext/array-fns';

import { formatErrorOnly } from '../../errors.ts';
import type { AssetResolver, ObjectRef } from '../../game/assets/assets.ts';
import { RENDER_PIPELINE_QUAD_PATH } from '../../game/assets/builtin-resources.ts';
import type { StructureModel } from '../../game/dynamic/dynamic-structures.ts';
import { axisLengths, withAxisLengths } from '../../game/effects/particle-mesh.ts';
import { billboardPlacement } from '../../game/prefabs/billboard.ts';
import { placePrefabLight, readPrefabLights, type PrefabLight } from '../../game/prefabs/prefab-lights.ts';
import type { PrefabRoots } from '../../game/prefabs/prefab-root.ts';
import { readPrefabRenderers, type PrefabRenderer } from '../../game/prefabs/prefab.ts';
import type { WorldIndex } from '../../game/world/world-index.ts';

import { onPivot } from './interactives.ts';
import { chainDraw, FLT_MAX, type PackContent } from './pack-content.ts';

// every prefab the scene places, whatever placed it (dynamic structures, facilities, cabins): its lights and
// renderers, once per prefab and pose, then placed per placement. a prefab that can't be read stands in as a
// box rather than failing the scene (docs/extraction/prefabs-and-interactives.md)

/**
 * places the lights and renderers of every placed prefab. a prefab's lights take their synthetic ids before
 * its renderers, placement by placement, so ids follow placement order
 *
 * @param world the world index, to find the particle quad
 * @param roots the placed prefabs' roots, shared with the pack's other prefab readers
 * @param content the pack's content; rows, lights, stand-ins and unsupported prefabs are added
 * @param placements every placed prefab, in placement order
 * @param floaterVolume by floating interactive's level logic id, its water volume's id
 */
export const placePrefabs = async (
	world: WorldIndex,
	roots: PrefabRoots,
	content: PackContent,
	placements: readonly StructureModel[],
	floaterVolume: ReadonlyMap<string, string>,
): Promise<void> => {
	const { scene } = content;
	const { subset } = scene;
	const { resolver } = roots;
	const particleQuad = await findParticleQuad(world, resolver);
	/** by prefab and pose: its renderers, or why they couldn't be read, and how reports name it */
	const prefabs = new Map<string, Promise<{ label: string; read: PrefabRenderer[] | FormatError }>>();
	const prefabLights = new Map<bigint, Promise<PrefabLight[]>>();
	content.count('prefabLights', 0);
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
		const found = roots.root(model.pathHash);
		const prefab = prefabs.getOrInsertComputed(`${model.pathHash}:${pose?.key ?? ''}:${locked}`, async () => {
			const { label, root } = await found;
			if (root instanceof FormatError) {
				content.unsupportedPrefab({ path: label, reason: root.message });
				return { label, read: root };
			}
			const read = await readPrefabRenderers(resolver, root, { viewPose: pose, particleQuad, locked }).catch(
				formatErrorOnly,
			);
			if (read instanceof FormatError) {
				content.unsupportedPrefab({ path: label, reason: read.message });
				return { label, read };
			}
			for (const { name, unsupported } of read) {
				if (unsupported !== null) {
					content.standIns.push({ path: label, name, reason: unsupported, position: null });
				}
			}
			return { label, read };
		});
		const rotation = unityEulerQuaternion(model.rotation);
		{
			// the prefab's own lights load with the placement too
			const read = prefabLights.getOrInsertComputed(model.pathHash, async () => {
				const { label, root } = await found;
				if (root instanceof FormatError) {
					// reported with the renderers
					return [];
				}
				const lights = await readPrefabLights(resolver, root).catch(formatErrorOnly);
				if (lights instanceof FormatError) {
					content.unsupportedPrefab({ path: label, reason: lights.message });
					return [];
				}
				return lights;
			});
			// oxlint-disable-next-line no-await-in-loop -- stable synthetic ids
			for (const prefabLight of await read) {
				const light = placePrefabLight(
					prefabLight,
					{ position: model.position, rotation, scale: model.scale },
					content.nextSyntheticId(levelTag),
				);
				if (content.addLight(light, placement.visibility)) {
					content.count('prefabLights');
				}
			}
		}
		const rootMatrix = trsMatrix(model.position, rotation, model.scale);
		const owner = { tag: levelTag, visibility: placement.visibility, loadGrid: placement.grid ?? null };
		// oxlint-disable-next-line no-await-in-loop -- stable asset ids and bounded bundle cache
		const { label, read } = await prefab;
		if (read instanceof FormatError) {
			// its size isn't known, so a metre cube stands on its pivot, scaled with the placement
			content.addStandInCube(
				{ ...owner, matrix: onPivot(rootMatrix) },
				{ path: label, name: label, reason: read.message },
			);
			continue;
		}
		const floatsOn = placement.logicId === undefined ? undefined : floaterVolume.get(placement.logicId);
		for (const renderer of read) {
			placeRenderer(content, renderer, { rootMatrix, owner, floatsOn });
		}
	}
};

/** places one renderer of a placed prefab */
const placeRenderer = (
	content: PackContent,
	renderer: PrefabRenderer,
	{
		rootMatrix,
		owner,
		floatsOn,
	}: {
		/** the placement's transform */
		rootMatrix: Float32Array;
		owner: { tag: number; visibility: StructureModel['visibility']; loadGrid: number | null };
		/** the id of the water volume the placement floats on */
		floatsOn: string | undefined;
	},
): void => {
	let matrix = multiplyMatrices(rootMatrix, renderer.matrix);
	if (renderer.ownSize) {
		matrix = withAxisLengths(matrix, axisLengths(renderer.matrix));
	}
	let bounds = transformBounds(renderer.bounds, matrix);
	if (renderer.billboard !== null) {
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
	content.addStructure(
		{
			chain: content.chains.intern(draws, {
				billboard: renderer.billboard?.flag ?? 0,
				distanceOrigin:
					renderer.distances === null
						? null
						: distanceOrigin(matrix, transformPoint(rootMatrix, renderer.distances.origin)),
			}),
			matrix,
			bounds,
			entityId,
			floatsOn,
		},
		{ ...owner, name: renderer.name },
	);
};

/** @returns a prefab renderer's draws: one per material and LOD span */
const rendererDraws = (content: PackContent, renderer: PrefabRenderer): ChainDraw[] => {
	let geometry: number;
	if (renderer.motion !== null) {
		geometry = content.geometries.internAnimatedObject(renderer.mesh, renderer.motion);
	} else if (renderer.pose !== null) {
		geometry = content.geometries.internPosedObject(renderer.mesh, renderer.pose);
	} else {
		geometry = content.geometries.internObject(renderer.mesh);
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
			content.materialOverrides.set(id, { saved });
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
 * @param matrix an instance's transform
 * @param origin a world point
 * @returns the point in the instance's frame, to the millimetre so placements of one prefab share chains; the
 *   instance's own origin when its transform has no inverse (a zero scale, so nothing draws)
 */
const distanceOrigin = (matrix: Float32Array, origin: readonly number[]): [number, number, number] => {
	let local: [number, number, number] = [0, 0, 0];
	try {
		local = inverseTransformPoint(matrix, origin);
	} catch (error) {
		if (!(error instanceof RangeError)) {
			throw error;
		}
	}
	return [
		Math.round(local[0] * 1000) / 1000,
		Math.round(local[1] * 1000) / 1000,
		Math.round(local[2] * 1000) / 1000,
	];
};

/** @returns the quad billboard particles draw, or `null` if the install doesn't have it where expected */
const findParticleQuad = async (world: WorldIndex, resolver: AssetResolver): Promise<ObjectRef | null> => {
	const [hash] = await world.hashesOf(RENDER_PIPELINE_QUAD_PATH);
	if (hash === undefined) {
		return null;
	}
	try {
		return await resolver.findUnique({ hash, path: RENDER_PIPELINE_QUAD_PATH }, UnityClass.Mesh);
	} catch {
		return null;
	}
};
