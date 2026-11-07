/* oxlint-disable no-await-in-loop -- traverse in authored order with bounded bundle residency */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type {
	ClipMaterialValue,
	ClipMotion,
	ClipTransformValue,
} from '@endfield-noclip/formats/unity/animation-clip';
import { type MaterialTextureSlot, parseMaterial } from '@endfield-noclip/formats/unity/material';
import { isTransformClass, UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import {
	inverseAffine,
	multiplyMatrices,
	trsMatrix,
	transformBounds,
	transformPoint,
} from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	aabbField,
	arrayField,
	asPPtr,
	booleanField,
	isObject,
	numberField,
	objectField,
	optionalNumberField,
	pptrField,
	stringField,
	type Aabb,
} from '@endfield-noclip/formats/unity/values';
import type { SkinAnimation } from '@endfield-noclip/package-format/geometry';
import { ChainFlags } from '@endfield-noclip/package-format/instances';
import {
	type ParticleForceFieldInfo,
	ParticleRenderMode,
	type ParticleSystemInfo,
} from '@endfield-noclip/package-format/particles';

import {
	isAdjustLengthType,
	isPositionFollowerType,
	lengthScale,
	lengthTextureTransform,
	type LengthTiling,
	readAdjustLength,
} from './adjust-length.ts';
import { animatorDefaultPose } from './animator-defaults.ts';
import { loadMesh } from './asset-decode.ts';
import { objectKey, type AssetResolver, type ObjectRef } from './assets.ts';
import { isBillboardType, type PrefabBillboard, readBillboard } from './billboard.ts';
import type { RootPath } from './curve-move.ts';
import {
	isEmissiveOverrideType,
	overriddenEmission,
	readEmissiveOverride,
	type Rgba,
} from './emissive-override.ts';
import {
	frozenParticleMatrix,
	meshParticlePivot,
	particleMeshSize,
	type LocalTransform,
	particleEmitterMatrix,
	particleStandInMatrix,
} from './particle-mesh.ts';
import {
	type ExternalForcesRead,
	InfluenceFilter,
	ScalingMode,
	particleReach,
	particleShapeMesh,
	readForceField,
	readParticleSystem,
} from './particle-system.ts';
import { isSplineMoverType, splineMoverRenderers } from './spline-movers.ts';
import {
	animatorHiddenNodes,
	type DistanceRange,
	effectDistanceLod,
	effectLodNodes,
	intersectRanges,
	isEffectSettingType,
	isOneShotEffect,
	isViewStateControllerType,
	playedEffectNodes,
} from './view-state-effects.ts';

/** one enabled mesh renderer in a prefab's highest-detail authored LOD */
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
	 * the viewer can't play draws its mesh once at the emitter (turned to the camera for quads), and a skinned
	 * mesh the reader can't pose draws unposed at its renderer, or posed without its blend shapes, and a
	 * renderer under a switched-off GameObject draws as it would once switched on
	 */
	unsupported: string | null;
	/**
	 * whether the matrix's axis lengths are already the renderer's size in the world, so the placement's scale
	 * moves it without sizing it: a stand-in or frozen particle whose scaling mode leaves out the scale above
	 * its system ({@link particleStandInMatrix})
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

/** bone matrices that move less than this between frames hold still */
const STILL = 1e-5;

const IDENTITY = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);

/** a ParticleSystemRenderer's `m_Pivot` components as clip bindings name them */
const PIVOT_ATTRIBUTES = ['x', 'y', 'z'].map((axis) => crc32(`m_Pivot.${axis}`) >>> 0);

/**
 * how a GameObject is switched off: `standIn` names why for a subtree drawn as stand-ins, and is `null` for
 * one the pose switches off, which draws nothing
 */
interface SwitchedOff {
	standIn: string | null;
}

/** a pose a prefab is drawn in instead of as saved: view states' clip end poses and the nodes they switch */
export interface PrefabPose {
	/** tells the poses of one prefab apart, for caching */
	key: string;
	/** clip end poses, one per Animator they bind below */
	clips: readonly PoseClip[];
	/** GameObjects the states switch on or off, by name */
	active: ReadonlyMap<string, boolean>;
	/** lengths the states set on GameObjects' `VFXAdjustLength`, by GameObject name; absent when none */
	lengths?: ReadonlyMap<string, number>;
	/**
	 * the root's matrices in the placement's space at evenly spaced times of a loop, for a prefab that moves as
	 * a whole (an auto-moving platform); absent for one that stays at its placement
	 */
	path?: RootPath;
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

/** a Transform as the walk met it, for posing it again at each frame of a clip */
interface PosedNode {
	/** the Transform's {@link objectKey} */
	key: string;
	/** the parent Transform's key, `null` for the prefab root */
	parent: string | null;
	/** the local transform as saved */
	saved: LocalTransform;
	/** per pose clip, the GameObject's path below that clip's Animator, `null` outside it */
	below: readonly (string | null)[];
}

/** an Animator above a GameObject */
interface AnimatorScope {
	/** binding paths below the Animator its clips never show ({@link animatorHiddenNodes}) */
	hidden: ReadonlySet<number>;
	/** the GameObject's path below the Animator, `/`-joined; '' for the Animator's own */
	path: string;
}

/** whether a MonoBehaviour is an `UnlockEffectConfigMono`, which swaps a model's locked and unlocked looks */
const isUnlockEffectConfigType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return names.has('useDifferentModel') && names.has('lockedModel') && names.has('unlockedModel');
};

const xyz = (value: TypeTreeObject): [number, number, number] => [
	numberField(value, 'x'),
	numberField(value, 'y'),
	numberField(value, 'z'),
];

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
	const candidates: {
		ref: ObjectRef;
		data: TypeTreeObject;
		matrix: Float32Array;
		name: string;
		mesh: ObjectRef;
		particles: ParticleSystemInfo | null;
		unsupported: string | null;
		ownSize: boolean;
		billboard: PrefabBillboard | null;
		/** material values the pose's clips set on the renderer */
		posedMaterials: readonly ClipMaterialValue[];
		distances: DistanceBands | null;
	}[] = [];
	// by renderer, the screen-relative heights an enabled LODGroup shows it at
	const lodSizes = new Map<string, SizeRange[]>();
	const seen = new Set<string>();
	const transforms = new Map<string, Float32Array>();
	// GameObjects a view-state controller switches on to play an effect, found before their subtrees are visited
	const played = new Set<string>();
	// GameObjects an EffectSetting's LOD table switches, found before their subtrees are visited
	const lodSwitched = new Set<string>();
	// by GameObject, whether the root's `UnlockEffectConfigMono` shows that model of its own, `null` where it
	// leaves the model as saved; found on the root, before its subtree is visited
	const lockModels = new Map<string, boolean | null>();
	// by GameObject, the distances an EffectSetting's distance LOD leaves it on at and that setting's GameObject,
	// found likewise
	const distanceSwitched = new Map<string, { ranges: DistanceRange[]; setting: string }>();
	const switchByDistance = (key: string, ranges: DistanceRange[], setting: string): void => {
		const known = distanceSwitched.get(key);
		// under nested tables, the later (inner) setting's origin
		distanceSwitched.set(key, {
			ranges: known === undefined ? ranges : intersectRanges(known.ranges, ranges),
			setting,
		});
	};
	// by GameObject with a distance LOD, its position in prefab space: where the camera's distance is measured from
	const settingOrigins = new Map<string, [number, number, number]>();
	// every Transform in walk order (parents first), for posing them at each frame of a looping clip
	const nodes: PosedNode[] = [];
	// by Transform, the local scale a length the pose sets gives it, found before the Transform is visited
	const lengthScales = new Map<string, [number, number, number]>();
	// by `PositionFollower` Transform, the Transform whose position it takes
	const followers = new Map<string, string>();
	// by candidate, its GameObject's Transform, for moving the candidates under a follower
	const candidateTransforms = new Map<(typeof candidates)[number], string>();
	// by renderer, the textures whose tiling follows a length the pose sets, and that length over its preset
	const lengthTilings = new Map<string, { tiling: LengthTiling; ratio: number }[]>();
	// by mesh renderer, its GameObject's Transform: what moves it when a looping clip turns that Transform
	const rendererTransforms = new Map<string, string>();
	// by component, the active and enabled force fields: their GameObject's layer and their prefab-space matrix
	const forceFields = new Map<string, { data: TypeTreeObject; layer: number; matrix: Float32Array }>();
	// by renderer, the emission colour an enabled `AnimationProperties_Emissive` writes to it
	const emissiveOverrides = new Map<string, Rgba>();
	// played systems whose force fields are resolved once every field's place is known, by candidate
	const pendingForces = new Map<
		(typeof candidates)[number],
		{ system: ObjectRef; forces: ExternalForcesRead; emitter: Float32Array; standIn: Float32Array }
	>();
	const visit = async (
		go: ObjectRef,
		parent: Float32Array,
		/** the parent's Transform, `null` for the root */
		parentTransform: string | null,
		isRoot: boolean,
		/** how the parent is switched off, `null` when it's drawn */
		parentOff: SwitchedOff | null,
		inherited: PrefabBillboard | null,
		/** per pose clip, the parent's path below that clip's Animator, `null` outside it */
		above: readonly (string | null)[],
		/** the Animators above the parent: what their clips never show, and the parent's path below each */
		animators: readonly AnimatorScope[],
		/** the distances the parent shows at, `null` for any */
		parentDistances: DistanceBands | null,
	): Promise<void> => {
		const key = objectKey(go);
		if (seen.has(key)) {
			throw new FormatError(`cyclic prefab hierarchy at ${key}`);
		}
		seen.add(key);
		const data = await resolver.read(go);
		const name = stringField(data, 'm_Name');
		const scopes: AnimatorScope[] = animators.map((scope) => ({
			hidden: scope.hidden,
			path: scope.path === '' ? name : `${scope.path}/${name}`,
		}));
		// clip bindings name GameObjects by their `/`-joined path below the Animator's own, which is ''
		const below = (pose?.clips ?? []).map((clip, i): string | null => {
			const parentPath = above[i] ?? null;
			if (parentPath !== null) {
				return parentPath === '' ? name : `${parentPath}/${name}`;
			}
			return (isRoot ? clip.animator === null : name === clip.animator) ? '' : null;
		});
		// renderer values the pose's clips leave on this GameObject
		const posedMaterials: ClipMaterialValue[] = [];
		const posedRenderer = new Map<number, number>();
		for (const [i, clip] of (pose?.clips ?? []).entries()) {
			const path = below[i];
			if (path === null) {
				continue;
			}
			const binding = crc32(path) >>> 0;
			posedMaterials.push(...(clip.materials.get(binding) ?? []));
			for (const [attribute, value] of clip.renderers.get(binding) ?? []) {
				posedRenderer.set(attribute, value);
			}
		}
		// a switched-off subtree draws only stand-ins, since a script or view state can switch it on, unless the
		// pose switched it off: that pose's other states are placed on their own. skinned meshes can still use its
		// transforms as bones
		let off = parentOff;
		const lockShown = lockModels.get(key);
		if (off === null && lockShown !== undefined) {
			// only the lock switches these models, so one it leaves off never shows
			if (!(lockShown ?? booleanField(data, 'm_IsActive'))) {
				off = { standIn: null };
			}
		} else if (off === null) {
			let posed = pose?.active.get(name);
			// a settled clip that switches GameObjects owns its subtree's activity: what it leaves off stays off
			let switching = false;
			for (const [i, clip] of (pose?.clips ?? []).entries()) {
				const path = below[i];
				if (path !== null && path !== '') {
					posed = clip.active.get(crc32(path) >>> 0) ?? posed;
					switching ||= clip.active.size > 0;
				}
			}
			if (posed === false || (posed === undefined && switching && !booleanField(data, 'm_IsActive'))) {
				off = { standIn: null };
			} else if (posed === undefined && !booleanField(data, 'm_IsActive')) {
				// an EffectSetting's LOD table can list its own GameObject, which the main loop below reads too late
				for (const item of arrayField(data, 'm_Component')) {
					const ref = isObject(item) ? await resolver.resolve(go, pptrField(item, 'component')) : null;
					if (ref !== null && ref.info.classId === UnityClass.MonoBehaviour && isEffectSettingType(ref)) {
						if ((await effectLodNodes(resolver, ref, await resolver.read(ref))).has(key)) {
							lodSwitched.add(key);
						}
					}
				}
				// a one-shot effect a view state plays shows for a moment, never at rest; what the prefab's own
				// Animator, or an effect's LOD table outside a view state, only ever holds off never shows
				const neverShown =
					scopes.some((scope) => scope.hidden.has(crc32(scope.path) >>> 0)) ||
					(lodSwitched.has(key) && !played.has(key));
				off =
					neverShown || (played.has(key) && (await isOneShotEffect(resolver, go)))
						? { standIn: null }
						: { standIn: 'switched off until a script or view state turns it on' };
			}
		}
		const standIn = off?.standIn ?? null;
		const drawn = off === null || standIn !== null;
		const wanted = drawn
			? [
					UnityClass.Transform,
					UnityClass.RectTransform,
					UnityClass.MeshFilter,
					UnityClass.MeshRenderer,
					UnityClass.SkinnedMeshRenderer,
					UnityClass.ParticleSystem,
					UnityClass.ParticleSystemRenderer,
					// LODGroup
					205,
				]
			: [UnityClass.Transform, UnityClass.RectTransform];
		const components: { ref: ObjectRef; data: TypeTreeObject }[] = [];
		const movers: { ref: ObjectRef; data: TypeTreeObject }[] = [];
		const fields: { ref: ObjectRef; data: TypeTreeObject }[] = [];
		// the Transform whose world position this GameObject takes (a `PositionFollower`'s source)
		let follows: ObjectRef | null = null;
		let board: TypeTreeObject | null = null;
		let hasDistanceLod = false;
		for (const item of arrayField(data, 'm_Component')) {
			if (!isObject(item)) {
				throw new FormatError('prefab component is not an object');
			}
			const ref = await resolver.resolve(go, pptrField(item, 'component'));
			if (ref === null) {
				continue;
			}
			if (wanted.includes(ref.info.classId)) {
				components.push({ ref, data: await resolver.read(ref) });
			} else if (off === null && ref.info.classId === UnityClass.ParticleSystemForceField) {
				const fieldData = await resolver.read(ref);
				if (booleanField(fieldData, 'm_Enabled')) {
					fields.push({ ref, data: fieldData });
				}
			} else if (drawn && ref.info.classId === UnityClass.MonoBehaviour && isBillboardType(ref)) {
				board = await resolver.read(ref);
			} else if (drawn && ref.info.classId === UnityClass.MonoBehaviour && isSplineMoverType(ref)) {
				const moverData = await resolver.read(ref);
				if (booleanField(moverData, 'm_Enabled')) {
					movers.push({ ref, data: moverData });
				}
			} else if (ref.info.classId === UnityClass.MonoBehaviour && isAdjustLengthType(ref)) {
				const length = pose?.lengths?.get(name);
				if (length === undefined) {
					continue;
				}
				const adjust = readAdjustLength(await resolver.read(ref));
				if (adjust.unread.length > 0) {
					throw new FormatError(`VFXAdjustLength ${adjust.unread.join(', ')} aren't read`);
				}
				for (const pointer of adjust.scaleTargets) {
					const target = await resolver.resolve(ref, pointer);
					if (target === null) {
						continue;
					}
					if (transforms.has(objectKey(target))) {
						throw new FormatError(`VFXAdjustLength on ${name} scales a Transform drawn before it`);
					}
					lengthScales.set(objectKey(target), lengthScale(adjust, length));
				}
				for (const tiling of adjust.tilings) {
					const renderer = await resolver.resolve(ref, tiling.renderer);
					if (renderer !== null) {
						lengthTilings
							.getOrInsertComputed(objectKey(renderer), () => [])
							.push({ tiling, ratio: length / adjust.preset });
					}
				}
			} else if (isRoot && ref.info.classId === UnityClass.MonoBehaviour && isUnlockEffectConfigType(ref)) {
				// the game looks the component up on the model's root and switches its models whether or not it's
				// enabled, and only for a placement with a mini-game or submit lock
				const config = await resolver.read(ref);
				if (booleanField(config, 'useDifferentModel')) {
					const lockedModel = await resolver.resolve(ref, pptrField(config, 'lockedModel'));
					const unlockedModel = await resolver.resolve(ref, pptrField(config, 'unlockedModel'));
					if (unlockedModel !== null) {
						lockModels.set(objectKey(unlockedModel), locked ? false : null);
					}
					if (lockedModel !== null) {
						lockModels.set(objectKey(lockedModel), locked ? true : null);
					}
				}
			} else if (
				off === null &&
				ref.info.classId === UnityClass.MonoBehaviour &&
				isEmissiveOverrideType(ref)
			) {
				// it starts playing when enabled, so only an active, enabled one sets the colour at rest
				const overrideData = await resolver.read(ref);
				if (booleanField(overrideData, 'm_Enabled')) {
					const { renderers, color } = readEmissiveOverride(overrideData);
					for (const pointer of renderers) {
						const renderer = await resolver.resolve(ref, pointer);
						if (renderer !== null) {
							emissiveOverrides.set(objectKey(renderer), color);
						}
					}
				}
			} else if (ref.info.classId === UnityClass.MonoBehaviour && isPositionFollowerType(ref)) {
				const followerData = await resolver.read(ref);
				if (booleanField(followerData, 'm_Enabled')) {
					follows = await resolver.resolve(ref, pptrField(followerData, 'source'));
				}
			} else if (ref.info.classId === UnityClass.MonoBehaviour && isViewStateControllerType(ref)) {
				for (const node of await playedEffectNodes(resolver, ref, await resolver.read(ref))) {
					played.add(node);
				}
			} else if (ref.info.classId === UnityClass.MonoBehaviour && isEffectSettingType(ref)) {
				const settingData = await resolver.read(ref);
				for (const node of await effectLodNodes(resolver, ref, settingData)) {
					lodSwitched.add(node);
				}
				const byDistance = await effectDistanceLod(resolver, ref, settingData);
				if (byDistance !== null) {
					hasDistanceLod = true;
					switchByDistance(key, byDistance.self, key);
					for (const [node, ranges] of byDistance.nodes) {
						switchByDistance(node, ranges, key);
					}
				}
			} else if (ref.info.classId === UnityClass.Animator) {
				const hidden = await animatorHiddenNodes(resolver, ref, await resolver.read(ref));
				if (hidden.size > 0) {
					scopes.push({ hidden, path: '' });
				}
			}
		}
		const transform = components.find((component) => isTransformClass(component.ref.info.classId));
		if (transform === undefined) {
			throw new FormatError(`prefab GameObject ${key} has no Transform`);
		}
		const t = transform.data;
		const rotation = objectField(t, 'm_LocalRotation');
		// the root's own placement comes from the caller
		const local: LocalTransform = isRoot
			? { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
			: {
					position: xyz(objectField(t, 'm_LocalPosition')),
					rotation: [...xyz(rotation), numberField(rotation, 'w')],
					scale: xyz(objectField(t, 'm_LocalScale')),
				};
		local.scale = lengthScales.get(objectKey(transform.ref)) ?? local.scale;
		if (follows !== null && !isRoot) {
			// moved once the whole hierarchy is placed, since its source can come later in the walk
			followers.set(objectKey(transform.ref), objectKey(follows));
		}
		nodes.push({ key: objectKey(transform.ref), parent: parentTransform, saved: { ...local }, below });
		for (const [i, clip] of (pose?.clips ?? []).entries()) {
			const path = below[i];
			if (isRoot || path === null) {
				continue;
			}
			for (const value of clip.transforms.get(crc32(path) >>> 0) ?? []) {
				switch (value.kind) {
					case 'position': {
						local.position = value.value;
						break;
					}
					case 'rotation': {
						local.rotation = value.value;
						break;
					}
					case 'scale': {
						local.scale = value.value;
						break;
					}
				}
			}
		}
		const matrix = isRoot
			? parent
			: multiplyMatrices(parent, trsMatrix(local.position, local.rotation, local.scale));
		transforms.set(objectKey(transform.ref), matrix);
		const ownCandidates = candidates.length;
		for (const field of fields) {
			forceFields.set(objectKey(field.ref), {
				data: field.data,
				layer: optionalNumberField(data, 'm_Layer') ?? 0,
				matrix,
			});
		}
		if (hasDistanceLod) {
			settingOrigins.set(key, [matrix[12], matrix[13], matrix[14]]);
		}
		let distances = parentDistances;
		{
			const own = distanceSwitched.get(key);
			// a setting is visited before what it switches, so its origin is known
			const origin = own && settingOrigins.get(own.setting);
			if (own !== undefined && origin !== undefined) {
				// under nested tables, the inner table's origin with both tables' ranges
				distances = {
					ranges: distances === null ? own.ranges : intersectRanges(distances.ranges, own.ranges),
					origin,
				};
			}
		}
		// a billboard sets its GameObject's world rotation, so the nearest one up the hierarchy wins
		const billboard = (board && readBillboard(board, matrix)) ?? inherited;
		for (const component of components) {
			if (component.ref.info.classId !== 205 || !booleanField(component.data, 'm_Enabled')) {
				continue;
			}
			// LOD i shows while the screen-relative height is in (its threshold, the previous LOD's]
			let upper = Infinity;
			for (const [lod, value] of arrayField(component.data, 'm_LODs').entries()) {
				if (!isObject(value)) {
					throw new FormatError('invalid prefab LOD');
				}
				const threshold = numberField(value, 'screenRelativeHeight');
				for (const renderer of arrayField(value, 'renderers')) {
					if (!isObject(renderer)) {
						throw new FormatError('invalid prefab LOD renderer');
					}
					const ref = await resolver.resolve(component.ref, pptrField(renderer, 'renderer'));
					if (ref !== null) {
						const ranges = lodSizes.getOrInsertComputed(objectKey(ref), () => []);
						// a renderer in consecutive LODs shows across all of them
						const last = ranges.at(-1);
						if (last !== undefined && last.min === upper) {
							last.min = threshold;
						} else {
							ranges.push({ lod, min: threshold, max: upper });
						}
					}
				}
				upper = threshold;
			}
		}
		for (const component of components) {
			if (
				component.ref.info.classId === UnityClass.SkinnedMeshRenderer &&
				booleanField(component.data, 'm_Enabled')
			) {
				const mesh = await resolver.resolve(component.ref, pptrField(component.data, 'm_Mesh'));
				if (mesh !== null) {
					candidates.push({
						...component,
						matrix,
						name,
						mesh,
						particles: null,
						unsupported: standIn,
						ownSize: false,
						billboard: null,
						posedMaterials,
						distances,
					});
				}
			}
		}
		const filter = components.find((component) => component.ref.info.classId === UnityClass.MeshFilter);
		if (filter !== undefined) {
			const mesh = await resolver.resolve(filter.ref, pptrField(filter.data, 'm_Mesh'));
			if (mesh !== null) {
				for (const component of components) {
					if (
						component.ref.info.classId === UnityClass.MeshRenderer &&
						booleanField(component.data, 'm_Enabled')
					) {
						rendererTransforms.set(objectKey(component.ref), objectKey(transform.ref));
						candidates.push({
							...component,
							matrix,
							name,
							mesh,
							particles: null,
							unsupported: standIn,
							ownSize: false,
							billboard,
							posedMaterials,
							distances,
						});
					}
				}
			}
		}
		const particles = components.find(
			(component) =>
				component.ref.info.classId === UnityClass.ParticleSystemRenderer &&
				booleanField(component.data, 'm_Enabled'),
		);
		const system = components.find((component) => component.ref.info.classId === UnityClass.ParticleSystem);
		if (particles !== undefined && system !== undefined) {
			// the pose can move the particles' pivot; a copy keeps the cached renderer as saved
			let rendererData = particles.data;
			if (PIVOT_ATTRIBUTES.some((attribute) => posedRenderer.has(attribute))) {
				const saved = objectField(rendererData, 'm_Pivot');
				const [x, y, z] = PIVOT_ATTRIBUTES.map(
					(attribute, i) => posedRenderer.get(attribute) ?? numberField(saved, 'xyz'[i]),
				);
				rendererData = { ...rendererData, m_Pivot: { x, y, z } };
			}
			// the placement's scale sizes stand-in and frozen particles only where the scaling mode keeps the scale
			// above the system: `Hierarchy`, or `Local` on the root, whose own scale the placement is
			const scalingMode = numberField(system.data, 'scalingMode');
			const ownSize = scalingMode === ScalingMode.Shape || (scalingMode === ScalingMode.Local && !isRoot);
			// a switched-off system stands in at its emitter whatever it would play
			let frozen: { matrix: Float32Array; mesh: ObjectRef } | null = null;
			if (standIn === null && numberField(rendererData, 'm_RenderMode') === ParticleRenderMode.Mesh) {
				const mesh = await resolver.resolve(particles.ref, pptrField(particles.data, 'm_Mesh'));
				if (mesh !== null) {
					const meshSize = particleMeshSize(aabbField(await resolver.read(mesh), 'm_LocalAABB'));
					const placed = frozenParticleMatrix(system.data, rendererData, parent, local, meshSize);
					frozen = placed === null ? null : { matrix: placed, mesh };
				}
			}
			if (frozen !== null) {
				candidates.push({
					...particles,
					matrix: frozen.matrix,
					name,
					mesh: frozen.mesh,
					particles: null,
					unsupported: null,
					ownSize,
					billboard: null,
					posedMaterials,
					distances,
				});
			} else {
				let read = readParticleSystem(system.data, rendererData);
				if (read !== null && 'info' in read && read.shapeMesh !== null) {
					const pending = read.shapeMesh;
					const shapeMesh = await resolver.resolve(system.ref, pending.mesh);
					const mesh =
						shapeMesh === null
							? 'no shape mesh'
							: particleShapeMesh(
									objectField(system.data, 'ShapeModule'),
									await loadMesh(resolver, shapeMesh),
								);
					read =
						typeof mesh === 'string'
							? { reason: mesh }
							: { ...read, info: { ...read.info, shape: { ...pending.shape, mesh } }, shapeMesh: null };
				}
				const emitter = particleEmitterMatrix(parent, local, scalingMode);
				// a system a script starts is still there to see, so it gets a stand-in too
				let reason = standIn;
				if (reason === null && read === null) {
					reason = `doesn't play on awake`;
				} else if (reason === null && read !== null && 'reason' in read) {
					reason = read.reason;
				}
				if (reason !== null) {
					// a stand-in shows where the system would play: its first mesh, or a quad facing the camera
					let mesh: ObjectRef | null = null;
					if (numberField(particles.data, 'm_RenderMode') === ParticleRenderMode.Mesh) {
						mesh = await resolver.resolve(particles.ref, pptrField(particles.data, 'm_Mesh'));
					}
					const quad = mesh === null;
					mesh ??= particleQuad;
					if (mesh !== null) {
						const placed = particleStandInMatrix(parent, local, scalingMode);
						candidates.push({
							...particles,
							matrix: placed,
							name,
							mesh,
							particles: null,
							unsupported: reason,
							ownSize,
							billboard: quad
								? { flag: ChainFlags.BillboardFacing, offset: [0, 0, 0, 1], frame: placed }
								: null,
							posedMaterials,
							distances,
						});
					}
				} else if (read !== null && 'info' in read) {
					// one emitter per mesh, each drawing the particles that picked it; quads have none of their own
					const meshes =
						read.meshes.length === 0
							? [particleQuad]
							: await Promise.all(read.meshes.map((pointer) => resolver.resolve(particles.ref, pointer)));
					for (const [i, mesh] of meshes.entries()) {
						if (mesh !== null) {
							let pivot = read.info.pivot;
							if (read.info.renderMode === ParticleRenderMode.Mesh) {
								// oxlint-disable-next-line no-await-in-loop -- mesh headers are cached by the resolver
								const bounds = aabbField(await resolver.read(mesh), 'm_LocalAABB');
								pivot = meshParticlePivot(pivot, particleMeshSize(bounds));
							}
							const candidate = {
								...particles,
								matrix: emitter,
								name,
								mesh,
								particles: { ...read.info, pivot, mesh: i },
								unsupported: null,
								ownSize: false,
								billboard: null,
								posedMaterials,
								distances,
							};
							candidates.push(candidate);
							if (read.forces !== null) {
								pendingForces.set(candidate, {
									system: system.ref,
									forces: read.forces,
									emitter,
									standIn: particleStandInMatrix(parent, local, scalingMode),
								});
							}
						}
					}
				}
			}
		}
		for (const mover of movers) {
			// the objects draw their LOD groups' first-LOD renderers, which live in other prefabs
			for (const renderer of await splineMoverRenderers(resolver, mover.ref, mover.data, standIn)) {
				candidates.push({
					...renderer,
					matrix,
					name,
					ownSize: false,
					billboard: null,
					posedMaterials: [],
					distances,
				});
			}
		}
		for (const candidate of candidates.slice(ownCandidates)) {
			candidateTransforms.set(candidate, objectKey(transform.ref));
		}
		for (const pointer of arrayField(t, 'm_Children')) {
			const child = await resolver.resolve(transform.ref, asPPtr(pointer));
			if (child !== null) {
				const childData = await resolver.read(child);
				const childGo = await resolver.resolve(child, pptrField(childData, 'm_GameObject'));
				if (childGo !== null) {
					await visit(
						childGo,
						matrix,
						objectKey(transform.ref),
						false,
						off,
						billboard,
						below,
						scopes,
						distances,
					);
				}
			}
		}
	};
	await visit(root, trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), null, true, null, null, [], [], null);
	// a follower takes its source's position, keeping its own rotation and scale, and moves its subtree with it
	for (const [follower, source] of followers) {
		const from = transforms.get(follower);
		const to = transforms.get(source);
		if (from === undefined || to === undefined) {
			throw new FormatError(`PositionFollower follows a Transform outside its prefab`);
		}
		const delta = [to[12] - from[12], to[13] - from[13], to[14] - from[14]];
		const moved = (matrix: Float32Array): Float32Array => {
			const copy = matrix.slice();
			for (let axis = 0; axis < 3; axis++) {
				copy[12 + axis] += delta[axis];
			}
			return copy;
		};
		const subtree = new Set([follower]);
		for (const node of nodes) {
			if (node.parent !== null && subtree.has(node.parent)) {
				subtree.add(node.key);
			}
			if (subtree.has(node.key)) {
				transforms.set(node.key, moved(transforms.get(node.key) ?? IDENTITY));
			}
			if (node.key === follower && node.parent !== null) {
				// looping clips pose it from here
				const parentMatrix = transforms.get(node.parent) ?? IDENTITY;
				node.saved.position = transformPoint(inverseAffine(parentMatrix), [to[12], to[13], to[14]]);
			}
		}
		for (const [candidate, transform] of candidateTransforms) {
			if (subtree.has(transform)) {
				candidate.matrix = moved(candidate.matrix);
			}
		}
	}
	// the fields a played system feels: those it lists, or those on its layers, within this prefab (wind zones
	// and fields elsewhere in the scene aren't followed)
	for (const [candidate, { system, forces, emitter, standIn }] of pendingForces) {
		const felt = new Set<string>();
		if (forces.filter !== InfluenceFilter.LayerMask) {
			for (const pointer of forces.list) {
				// oxlint-disable-next-line no-await-in-loop -- references are cached by the resolver
				const ref = await resolver.resolve(system, pointer);
				if (ref !== null && forceFields.has(objectKey(ref))) {
					felt.add(objectKey(ref));
				}
			}
		}
		if (forces.filter !== InfluenceFilter.List) {
			for (const [key, field] of forceFields) {
				if (((forces.mask >>> field.layer) & 1) !== 0) {
					felt.add(key);
				}
			}
		}
		const infos: ParticleForceFieldInfo[] = [];
		let reason: string | null = null;
		for (const key of felt) {
			const field = forceFields.get(key);
			if (field === undefined) {
				continue;
			}
			const read = readForceField(field.data, multiplyMatrices(inverseAffine(field.matrix), emitter));
			if (typeof read === 'string') {
				reason = read;
				break;
			}
			infos.push(read);
		}
		const particles = candidate.particles;
		if (reason !== null) {
			// a field the viewer can't step makes the system a stand-in
			candidate.particles = null;
			candidate.unsupported = reason;
			candidate.matrix = standIn;
		} else if (infos.length > 0 && particles?.motion.kind === 'free') {
			candidate.particles = {
				...particles,
				motion: { ...particles.motion, forces: { multiplier: forces.multiplier, fields: infos } },
			};
		}
	}
	const frames = pose === null ? null : poseFrames(nodes, pose);
	const result: PrefabRenderer[] = [];
	for (const candidate of candidates) {
		const key = objectKey(candidate.ref);
		const materials: (ObjectRef | null)[] = [];
		for (const pointer of arrayField(candidate.data, 'm_Materials')) {
			// oxlint-disable-next-line no-await-in-loop -- preserve renderer slot order
			const ref = await resolver.resolve(candidate.ref, asPPtr(pointer));
			materials.push(ref);
		}
		// oxlint-disable-next-line no-await-in-loop -- mesh headers are cached by the resolver
		const mesh = await resolver.read(candidate.mesh);
		if (arrayField(mesh, 'm_SubMeshes').length === 0 || materials.length === 0) {
			continue;
		}
		let matrix = candidate.matrix;
		let bounds = aabbField(mesh, 'm_LocalAABB');
		if (candidate.particles !== null) {
			bounds = particleReach(
				candidate.particles,
				Math.hypot(...bounds.center) + Math.hypot(...bounds.extents),
			);
		}
		let skin: Float32Array[] | null = null;
		let motion: RendererMotion | null = null;
		let unsupported = candidate.unsupported;
		const rigidTransform = rendererTransforms.get(key);
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
			const posed = await poseSkin(resolver, candidate, mesh, meshBounds, transforms);
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
			// oxlint-disable-next-line no-await-in-loop -- material reads are cached by the resolver
			materialValues.push(
				material === null
					? null
					: await posedMaterialValues(resolver, material, {
							values: candidate.posedMaterials,
							tilings: lengthTilings.get(key) ?? [],
							emissive: emissiveOverrides.get(key) ?? null,
						}),
			);
		}
		result.push({
			name: candidate.name,
			matrix,
			bounds,
			pose: skin,
			motion,
			mesh: candidate.mesh,
			materials,
			materialValues,
			distances: candidate.distances,
			sizes: lodSizes.get(key)?.map(({ lod, min, max }) => ({ lod, min, max })) ?? null,
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
		});
	}
	return result;
};

/** @returns property names by the hash clip bindings name them with: the low 28 bits of their CRC32 */
const byHash = (names: Iterable<string>): Map<number, string> =>
	new Map([...names].map((name) => [crc32(name) & 0x0fff_ffff, name]));

/**
 * resolves the material values a pose sets on a renderer against one of its materials. clips name properties
 * by a hash of the name, so a value whose property the material doesn't save is left out; so is the tiling of
 * a texture it doesn't save
 *
 * @param sources.values the values the pose's clips set
 * @param sources.tilings textures whose tiling follows a length the pose sets, with that length over its
 *   preset
 * @param sources.emissive the emission override the renderer's `AnimationProperties_Emissive` writes, or
 *   `null`; folded into `_EmissiveColor` after the clips' values
 * @returns the replaced values by name, or `null` when none of this material's are replaced
 */
const posedMaterialValues = async (
	resolver: AssetResolver,
	material: ObjectRef,
	sources: {
		values: readonly ClipMaterialValue[];
		tilings: readonly { tiling: LengthTiling; ratio: number }[];
		emissive: Rgba | null;
	},
): Promise<MaterialValues | null> => {
	const { values, tilings, emissive } = sources;
	if (values.length === 0 && tilings.length === 0 && emissive === null) {
		return null;
	}
	const record = parseMaterial(await resolver.read(material));
	const textures: MaterialValues['textures'] = {};
	for (const { tiling, ratio } of tilings) {
		const slot = record.textures[tiling.texture];
		if (slot !== undefined) {
			textures[tiling.texture] = lengthTextureTransform(slot, tiling, ratio);
		}
	}
	const floatNames = byHash([...Object.keys(record.floats), ...Object.keys(record.ints)]);
	const colorNames = byHash(Object.keys(record.colors));
	const floats: Record<string, number> = {};
	const colors: Record<string, [number, number, number, number]> = {};
	for (const { nameHash, component, value } of values) {
		if (component === null) {
			const name = floatNames.get(nameHash);
			if (name !== undefined) {
				floats[name] = value;
			}
			continue;
		}
		const name = colorNames.get(nameHash);
		if (name !== undefined) {
			colors[name] ??= [...record.colors[name]];
			colors[name][component] = value;
		}
	}
	{
		const name = '_EmissiveColor';
		const saved = colors[name] ?? record.colors[name];
		if (emissive !== null && saved !== undefined) {
			colors[name] = overriddenEmission(saved, emissive);
		}
	}
	return Object.keys(floats).length + Object.keys(colors).length + Object.keys(textures).length === 0
		? null
		: { floats, colors, textures };
};

/**
 * bakes a skinned renderer's authored pose: each bone's prefab-space matrix times its bind pose
 *
 * @returns the bone matrices, the bounds every weighted position lies in, and per bone its Transform's key
 *   and bind pose; or why the skeleton can't be posed
 */
const poseSkin = async (
	resolver: AssetResolver,
	renderer: { ref: ObjectRef; data: TypeTreeObject },
	mesh: TypeTreeObject,
	meshBounds: Aabb,
	transforms: ReadonlyMap<string, Float32Array>,
): Promise<PosedSkin | { reason: string }> => {
	const bones = arrayField(renderer.data, 'm_Bones');
	const bindPoses = arrayField(mesh, 'm_BindPose');
	if (bones.length !== bindPoses.length || bones.length === 0) {
		return { reason: 'invalid skeleton' };
	}
	const skin: Float32Array[] = [];
	const boneKeys: string[] = [];
	const binds: Float32Array[] = [];
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	for (const [i, pointer] of bones.entries()) {
		// oxlint-disable-next-line no-await-in-loop -- bones are few and their reads cached
		const bone = await resolver.resolve(renderer.ref, asPPtr(pointer));
		const boneMatrix = bone && transforms.get(objectKey(bone));
		const bind = bindPoses[i];
		if (!boneMatrix || !isObject(bind)) {
			return { reason: 'unresolved bone' };
		}
		const bindMatrix = new Float32Array(
			Array.from({ length: 16 }, (_, k) => numberField(bind, 'e' + (k % 4) + Math.floor(k / 4))),
		);
		const posed = multiplyMatrices(boneMatrix, bindMatrix);
		skin.push(posed);
		boneKeys.push(objectKey(bone));
		binds.push(bindMatrix);
		const transformed = transformBounds(meshBounds, posed);
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], transformed.center[axis] - transformed.extents[axis]);
			max[axis] = Math.max(max[axis], transformed.center[axis] + transformed.extents[axis]);
		}
	}
	// weighted positions lie inside this union, including poses whose bones move beyond the bind bounds
	return { skin, bounds: boxBounds(min, max), bones: boneKeys, binds };
};

/** a skinned renderer posed by {@link poseSkin} */
interface PosedSkin {
	skin: Float32Array[];
	bounds: Aabb;
	/** per bone, its Transform's {@link objectKey} */
	bones: string[];
	/** per bone, its bind pose */
	binds: Float32Array[];
}

const boxBounds = (min: readonly number[], max: readonly number[]): Aabb => ({
	center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
	extents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
});

/** every Transform's prefab-space matrix at each frame of a pose's looping clip */
interface PoseFrames {
	frameRate: number;
	/** per frame, by Transform key */
	matrices: Map<string, Float32Array>[];
}

/**
 * poses the prefab's Transforms at each frame of the pose's root path, else of its first looping clip that
 * moves any; the pose's other clips hold their end poses, and its looping clips play on those frames
 *
 * @param nodes the walk's Transforms, parents first
 * @param pose the pose the walk drew
 * @returns the frames, or `null` when nothing keeps moving a Transform
 */
const poseFrames = (nodes: readonly PosedNode[], pose: PrefabPose): PoseFrames | null => {
	const playing = pose.clips.find(
		(clip) => clip.motion !== null && clip.motion.loops && clip.motion.paths.length > 0,
	)?.motion;
	let frameRate: number;
	let frameCount: number;
	if (pose.path !== undefined) {
		frameRate = pose.path.frameRate;
		frameCount = pose.path.matrices.length;
	} else if (playing !== undefined && playing !== null && playing.duration > 0 && playing.sampleRate > 0) {
		frameRate = playing.sampleRate;
		frameCount = Math.max(Math.round(playing.duration * frameRate), 1);
	} else {
		return null;
	}
	const matrices: Map<string, Float32Array>[] = [];
	for (let frame = 0; frame < frameCount; frame++) {
		const time = frame / frameRate;
		const sampled = pose.clips.map((clip) =>
			clip.motion?.loops === true ? clip.motion.sample(time % clip.motion.duration) : clip.transforms,
		);
		const posed = new Map<string, Float32Array>();
		for (const node of nodes) {
			const parent = node.parent === null ? undefined : posed.get(node.parent);
			if (parent === undefined) {
				// the root keeps the caller's placement, moved along its path if it has one
				posed.set(node.key, pose.path?.matrices[frame] ?? trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]));
				continue;
			}
			const local = { ...node.saved };
			for (const [i, values] of sampled.entries()) {
				const path = node.below[i];
				for (const value of path === null ? [] : (values.get(crc32(path) >>> 0) ?? [])) {
					switch (value.kind) {
						case 'position': {
							local.position = value.value;
							break;
						}
						case 'rotation': {
							local.rotation = value.value;
							break;
						}
						case 'scale': {
							local.scale = value.value;
							break;
						}
					}
				}
			}
			posed.set(node.key, multiplyMatrices(parent, trsMatrix(local.position, local.rotation, local.scale)));
		}
		matrices.push(posed);
	}
	return { frameRate, matrices };
};

/**
 * @param frames the prefab's Transforms at each frame of its looping clip
 * @param posed the renderer's skeleton: per bone, its Transform's key and bind pose
 * @param meshBounds the mesh's own bounds
 * @returns the bones' skinning matrices at each frame and the bounds they keep the mesh in, or `null` when no
 *   bone moves
 */
const skinMotion = (
	frames: PoseFrames,
	posed: Pick<PosedSkin, 'bones' | 'binds'>,
	meshBounds: Aabb,
): { motion: SkinMotion; bounds: Aabb } | null => {
	const boneCount = posed.bones.length;
	const frameCount = frames.matrices.length;
	const matrices = new Float32Array(frameCount * boneCount * 12);
	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];
	let moves = false;
	for (const [frame, byKey] of frames.matrices.entries()) {
		for (let bone = 0; bone < boneCount; bone++) {
			const boneMatrix = byKey.get(posed.bones[bone]);
			if (boneMatrix === undefined) {
				return null;
			}
			const skin = multiplyMatrices(boneMatrix, posed.binds[bone]);
			const at = (frame * boneCount + bone) * 12;
			// column-major to rows3x4
			for (let row = 0; row < 3; row++) {
				for (let column = 0; column < 4; column++) {
					matrices[at + row * 4 + column] = skin[column * 4 + row];
				}
			}
			for (let k = 0; k < 12; k++) {
				moves ||= Math.abs(matrices[at + k] - matrices[bone * 12 + k]) > STILL;
			}
			const box = transformBounds(meshBounds, skin);
			for (let axis = 0; axis < 3; axis++) {
				min[axis] = Math.min(min[axis], box.center[axis] - box.extents[axis]);
				max[axis] = Math.max(max[axis], box.center[axis] + box.extents[axis]);
			}
		}
	}
	if (!moves) {
		return null;
	}
	return {
		motion: { boneCount, frameCount, frameRate: frames.frameRate, matrices },
		bounds: boxBounds(min, max),
	};
};
