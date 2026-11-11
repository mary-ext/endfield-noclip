/* oxlint-disable no-await-in-loop -- resolves renderers in walk order with bounded bundle residency */
import type {
	ClipMaterialValue,
	ClipMotion,
	ClipTransformValue,
} from '@endfield-noclip/formats/unity/animation-clip';
import type { MaterialTextureSlot } from '@endfield-noclip/formats/unity/material';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { trsMatrix } from '@endfield-noclip/formats/unity/transform';
import {
	aabbField,
	arrayField,
	asPPtr,
	numberField,
	optionalNumberField,
	type Aabb,
} from '@endfield-noclip/formats/unity/values';
import type { SkinAnimation } from '@endfield-noclip/package-format/geometry';
import type { ParticleSystemInfo } from '@endfield-noclip/package-format/particles';

import { objectKey, type AssetResolver, type ObjectRef } from '../assets/assets.ts';
import { particleReach } from '../effects/particle-system.ts';
import type { DistanceRange } from '../effects/view-state-effects.ts';

import { animatorDefaultPose } from './animator-defaults.ts';
import type { PrefabBillboard } from './billboard.ts';
import type { EmissiveColors } from './emissive-override.ts';
import { posedMaterialValues } from './material-values.ts';
import { walkPrefab } from './prefab-walk.ts';
import { moveFollowers, resolveForces } from './renderer-passes.ts';
import {
	ABOVE_ROOT,
	createRendererWalk,
	type RendererCandidate,
	rendererVisitor,
	type RendererWalk,
} from './renderer-walk.ts';
import { type PoseFrames, poseFrames, poseSkin, skinMotion } from './skin-pose.ts';

// #region types

/** one enabled renderer of a prefab, whichever LOD it belongs to ({@link sizes}) */
export interface PrefabRenderer {
	name: string;
	matrix: Float32Array;
	bounds: Aabb;
	mesh: ObjectRef;
	materials: (ObjectRef | null)[];
	submeshes: number;
	shadowOnly: boolean;
	/**
	 * the renderer's sorting layer (the layer's place in the layer order) and its order within it, Unity's
	 * `m_SortingLayer` and `m_SortingOrder`: transparent draws sort by them before their distance
	 */
	sorting: { layer: number; order: number };
	/** bone transforms including bind poses, when geometry must be baked into prefab space */
	pose: Float32Array[] | null;
	/**
	 * the looping clip the renderer plays, in prefab space, `null` when it holds still. the geometry then plays
	 * it from its bind space (a rigid renderer's mesh space) instead of being baked into {@link pose}, and
	 * {@link matrix} is the identity
	 */
	motion: RendererMotion | null;
	/**
	 * the particle system that draws the mesh once per particle, `null` for an ordinary renderer. the matrix is
	 * then the system's frame and the bounds everywhere its particles reach
	 */
	particles: ParticleSystemInfo | null;
	/**
	 * why the renderer can't draw as the game does, `null` when it can. it's then a stand-in: a particle system
	 * the viewer can't play draws its mesh once at the emitter (turned to the camera for quads), a skinned mesh
	 * the reader can't pose draws unposed at its renderer, or posed without its blend shapes, and a renderer
	 * under a switched-off GameObject draws as it would once switched on
	 */
	unsupported: string | null;
	/**
	 * whether the matrix's axis lengths are already the renderer's size in the world, so the placement's scale
	 * moves it without sizing it: a stand-in or frozen particle whose scaling mode leaves out the scale above
	 * its system (`particleStandInMatrix`)
	 */
	ownSize: boolean;
	/**
	 * the billboard on the renderer's GameObject or its nearest ancestor with one, `null` when nothing turns it
	 * to the camera. skinned meshes and particle systems don't take it
	 */
	billboard: PrefabBillboard | null;
	/**
	 * per material slot, the saved values the pose's clips or an emission override replace on this renderer,
	 * `null` where they replace none
	 */
	materialValues: (MaterialValues | null)[];
	/** where the effect LOD tables above the renderer show it by camera distance; `null` when nothing does */
	distances: DistanceBands | null;
	/**
	 * where an enabled LODGroup shows the renderer, ascending by LOD; `null` outside any. the heights are
	 * measured on the LODGroup's own size in the game
	 */
	sizes: readonly SizeRange[] | null;
}

/** a span of screen-relative heights (Unity's LODGroup metric) a LODGroup shows a renderer at */
export interface SizeRange {
	/** the first LOD of the span */
	lod: number;
	/** shown while `min < height <= max`; `max` is infinite on LOD 0 */
	min: number;
	max: number;
}

/** the camera distances an effect's distance LOD shows something at */
export interface DistanceBands {
	/** ascending */
	ranges: readonly DistanceRange[];
	/** the point they're measured from, in prefab space: the EffectSetting's GameObject */
	origin: [x: number, y: number, z: number];
}

/**
 * material values a pose or an emission override sets on a renderer, by property name, replacing the
 * material's saved ones
 */
export interface MaterialValues {
	floats: Record<string, number>;
	colors: Record<string, [number, number, number, number]>;
	/** texture scales and offsets, by texture property */
	textures: Record<string, Pick<MaterialTextureSlot, 'scale' | 'offset'>>;
}

/** a skeletal animation for a geometry: {@link SkinAnimation} without the box its positions lie in */
export type SkinMotion = Omit<SkinAnimation, 'offset' | 'scale'>;

/** a looping animation a renderer plays */
export interface RendererMotion {
	/**
	 * `skinned`: a skinned renderer's bones; `rigid`: a mesh renderer's own Transform, as the one bone every
	 * vertex follows, so its mesh's own bone weights (if any) are never read
	 */
	kind: 'skinned' | 'rigid';
	skin: SkinMotion;
}

/** a pose a prefab is drawn in instead of as saved: view states' clip end poses and the nodes they switch */
export interface PrefabPose {
	/** tells the poses of one prefab apart, for caching */
	key: string;
	/** clip end poses, one per Animator they bind below */
	clips: readonly PoseClip[];
	/** GameObjects the states switch on or off, by name */
	active: ReadonlyMap<string, boolean>;
	/** set when the states switch the prefab root off, so no part of the prefab shows */
	hidden?: boolean;
	/** lengths the states set on GameObjects' `VFXAdjustLength`, by GameObject name; absent when none */
	lengths?: ReadonlyMap<string, number>;
	/**
	 * emissive configs the states leave on GameObjects' `AnimationProperties_Emissive`, by GameObject name;
	 * absent when none
	 */
	emissive?: ReadonlyMap<string, EmissiveColors>;
	/**
	 * set when nothing but this pose switches the prefab's GameObjects (no view state and no component), so
	 * what it leaves switched off never shows instead of drawing as stand-ins
	 */
	closed?: boolean;
}

/** what one Animator's clip leaves its subtree at */
export interface PoseClip {
	/** the GameObject whose Animator the clip binds below, by name; `null` for the prefab root */
	animator: string | null;
	/** Transform values by binding path (CRC32 of the path below the Animator) */
	transforms: ReadonlyMap<number, readonly ClipTransformValue[]>;
	/** GameObjects the clip switches on or off, by binding path */
	active: ReadonlyMap<number, boolean>;
	/** material properties the clip sets on renderers, by binding path */
	materials: ReadonlyMap<number, readonly ClipMaterialValue[]>;
	/** other renderer properties the clip sets, by binding path, then by attribute */
	renderers: ReadonlyMap<number, ReadonlyMap<number, number>>;
	/** the clip's Transform values over time when it keeps playing (a looping clip), else `null` */
	motion: ClipMotion | null;
}

// #endregion

const IDENTITY = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

/**
 * walks a prefab's hierarchy and resolves the active renderers' dependencies through their exact PPtrs. an
 * enabled LODGroup's renderers carry the screen-relative heights it shows them at, matched by identity, never
 * by name
 *
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @param options.viewPose a view-state pose to draw instead of the saved one, or `null` to draw what the
 *   prefab's own Animators play ({@link animatorDefaultPose}); the root's own Transform keeps the caller's
 *   placement
 * @param options.particleQuad the unit quad billboard particle systems draw, or `null` to skip them
 * @param options.locked whether the placement starts locked by a mini-game or submit lock, which switches a
 *   root `UnlockEffectConfigMono`'s locked model on and its unlocked model off
 * @returns enabled mesh renderers relative to the prefab root; the caller supplies the root placement. those
 *   under GameObjects switched off as saved are stand-ins ({@link PrefabRenderer.unsupported}); those the
 *   pose or lock switches off are left out
 * @throws {FormatError} on malformed hierarchy, missing references or unsupported renderer dependencies
 */
export const readPrefabRenderers = async (
	resolver: AssetResolver,
	root: ObjectRef,
	options: { viewPose: PrefabPose | null; particleQuad: ObjectRef | null; locked: boolean },
): Promise<PrefabRenderer[]> => {
	const { viewPose, particleQuad, locked } = options;
	// view states drive their model's Animators; only a prefab without them plays its controllers' defaults
	const pose = viewPose ?? (await animatorDefaultPose(resolver, root));
	const walk = createRendererWalk(resolver, { pose, particleQuad, locked });
	await walkPrefab(resolver, root, rendererVisitor(walk), ABOVE_ROOT);
	moveFollowers(walk);
	await resolveForces(walk);
	const frames = pose === null ? null : poseFrames(walk.nodes, pose);
	const result: PrefabRenderer[] = [];
	for (const candidate of walk.candidates) {
		const renderer = await assembleRenderer(walk, candidate, frames);
		if (renderer !== null) {
			result.push(renderer);
		}
	}
	return result;
};

/**
 * resolves a candidate's materials, bounds and pose
 *
 * @param walk the finished walk
 * @param candidate one of its candidates
 * @param frames the prefab's Transforms at each frame of its looping clip, or `null` when nothing loops
 * @returns the renderer, or `null` for one with no submeshes or materials
 */
const assembleRenderer = async (
	walk: RendererWalk,
	candidate: RendererCandidate,
	frames: PoseFrames | null,
): Promise<PrefabRenderer | null> => {
	const { resolver } = walk;
	const key = objectKey(candidate.ref);
	const materials: (ObjectRef | null)[] = [];
	for (const pointer of arrayField(candidate.data, 'm_Materials')) {
		// preserve renderer slot order
		materials.push(await resolver.resolve(candidate.ref, asPPtr(pointer)));
	}
	// mesh headers are cached by the resolver
	const mesh = await resolver.read(candidate.mesh);
	if (arrayField(mesh, 'm_SubMeshes').length === 0 || materials.length === 0) {
		return null;
	}
	let matrix = candidate.matrix;
	let bounds = aabbField(mesh, 'm_LocalAABB');
	if (candidate.particles !== null) {
		bounds = particleReach(candidate.particles, Math.hypot(...bounds.center) + Math.hypot(...bounds.extents));
	}
	let skin: Float32Array[] | null = null;
	let motion: RendererMotion | null = null;
	let unsupported = candidate.unsupported;
	const rigidTransform = walk.rendererTransforms.get(key);
	if (frames !== null && rigidTransform !== undefined && candidate.billboard === null) {
		// a mesh renderer under a Transform the clip moves follows it as a one-bone skin in its mesh space
		const moving = skinMotion(frames, { bones: [rigidTransform], binds: [IDENTITY] }, bounds);
		if (moving !== null) {
			motion = { kind: 'rigid', skin: moving.motion };
			bounds = moving.bounds;
			matrix = IDENTITY;
		}
	} else if (candidate.ref.info.classId === UnityClass.SkinnedMeshRenderer) {
		// a skinned mesh the reader can't pose stands in unposed, at its renderer, rather than failing the prefab
		const meshBounds = bounds;
		const posed = await poseSkin(resolver, candidate, mesh, meshBounds, walk.transforms);
		if ('reason' in posed) {
			unsupported = posed.reason;
		} else {
			skin = posed.skin;
			bounds = posed.bounds;
			matrix = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
			const moving = frames === null ? null : skinMotion(frames, posed, meshBounds);
			if (moving !== null) {
				motion = { kind: 'skinned', skin: moving.motion };
				bounds = moving.bounds;
			}
			// the mesh is baked without its blend shapes, so it isn't the shape the game draws
			if (arrayField(candidate.data, 'm_BlendShapeWeights').some((weight) => weight !== 0)) {
				unsupported ??= 'nonzero blend shape';
			}
		}
	}
	const materialValues: (MaterialValues | null)[] = [];
	for (const material of materials) {
		// material reads are cached by the resolver
		materialValues.push(
			material === null
				? null
				: await posedMaterialValues(resolver, material, {
						values: candidate.posedMaterials,
						tilings: walk.lengthTilings.get(key) ?? [],
						emissive: walk.emissiveOverrides.get(key) ?? null,
					}),
		);
	}
	return {
		name: candidate.name,
		matrix,
		bounds,
		pose: skin,
		motion,
		mesh: candidate.mesh,
		materials,
		materialValues,
		distances: candidate.distances,
		sizes: walk.lodSizes.get(key)?.map(({ lod, min, max }) => ({ lod, min, max })) ?? null,
		submeshes: arrayField(mesh, 'm_SubMeshes').length,
		// Unity's ShadowCastingMode: 3 ShadowsOnly, 4 ShadowsOnlyTwoSided
		shadowOnly: numberField(candidate.data, 'm_CastShadows') >= 3,
		sorting: {
			layer: optionalNumberField(candidate.data, 'm_SortingLayer') ?? 0,
			order: optionalNumberField(candidate.data, 'm_SortingOrder') ?? 0,
		},
		particles: candidate.particles,
		unsupported,
		// a renderer the clip moves takes the identity matrix
		ownSize: candidate.ownSize && motion === null,
		billboard: candidate.billboard,
	};
};
