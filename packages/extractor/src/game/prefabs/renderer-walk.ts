/* oxlint-disable no-await-in-loop -- reads a GameObject's components in authored order */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import type { ClipMaterialValue, ClipMotion } from '@endfield-noclip/formats/unity/animation-clip';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import { booleanField, optionalNumberField, pptrField } from '@endfield-noclip/formats/unity/values';
import type { ParticleSystemInfo } from '@endfield-noclip/package-format/particles';

import { objectKey, type AssetResolver, type ObjectRef } from '../assets/assets.ts';
import type { LocalTransform } from '../effects/particle-mesh.ts';
import type { ExternalForcesRead } from '../effects/particle-system.ts';
import {
	animatorHiddenNodes,
	type DistanceRange,
	effectDistanceLod,
	effectLodNodes,
	effectProxyBands,
	intersectRanges,
	isEffectSettingType,
	isOneShotEffect,
	isViewStateControllerType,
	playedEffectNodes,
	PROXY_LEVELS,
} from '../effects/view-state-effects.ts';

import {
	isAdjustLengthType,
	isPositionFollowerType,
	lengthScale,
	readAdjustLength,
} from './adjust-length.ts';
import { isBillboardType, type PrefabBillboard, readBillboard } from './billboard.ts';
import {
	isEmissiveOverrideType,
	readEmissiveOverride,
	type EmissiveColors,
	ROOT_EMISSIVE,
} from './emissive-override.ts';
import type { ScaledTiling } from './material-values.ts';
import { bindingKey, type ClipPaths, clipPaths, posedLocal } from './pose-paths.ts';
import type { PlacedPrefabNode, PrefabComponent, PrefabNode, PrefabVisitor } from './prefab-walk.ts';
import type { DistanceBands, EffectLodSource, PrefabPose, SizeRange } from './prefab.ts';
import { CANDIDATE_SOURCES } from './renderer-candidates.ts';
import type { PosedNode } from './skin-pose.ts';

// the walk behind `readPrefabRenderers`. at each GameObject, in order: whether it's switched off
// ({@link switchedOff}), its components ({@link COMPONENT_READERS}), its local transform, then once placed
// what needs its matrix ({@link PLACEMENT_STEPS}) and, when it draws, its renderers (`CANDIDATE_SOURCES`).
// a new component kind is one reader when it acts on other GameObjects or the pose, one placement step when
// it needs its own matrix, or one candidate source when it draws.

// #region state

const ALL_PROXY_LEVELS = (1 << PROXY_LEVELS) - 1;

/** a renderer the walk found, before its materials, bounds and pose are resolved */
export interface RendererCandidate {
	ref: ObjectRef;
	data: TypeTreeObject;
	name: string;
	matrix: Float32Array;
	mesh: ObjectRef;
	particles: ParticleSystemInfo | null;
	unsupported: string | null;
	ownSize: boolean;
	billboard: PrefabBillboard | null;
	/** material values the pose's clips set on the renderer */
	posedMaterials: readonly ClipMaterialValue[];
	/** the pose's looping clips that keep changing the renderer's material values */
	playedMaterials: readonly PlayedMaterials[];
	distances: DistanceBands | null;
	proxyLevels: number | null;
}

/** a looping clip's material values on one renderer */
export interface PlayedMaterials {
	/** the clip as its state plays it */
	motion: ClipMotion;
	/** the renderer's binding path in the clip */
	binding: number;
}

/** a played particle system's external forces, resolved once every force field is placed */
export interface PendingForces {
	system: ObjectRef;
	forces: ExternalForcesRead;
	emitter: Float32Array;
	/** where the system stands in if a field it feels can't be stepped */
	standIn: Float32Array;
}

/** an active, enabled force field */
export interface PlacedForceField {
	data: TypeTreeObject;
	/** its GameObject's layer */
	layer: number;
	matrix: Float32Array;
}

/**
 * what the renderer walk collects across a prefab. a GameObject can switch, scale or tint others met later in
 * the walk, so what it finds is kept here, by the target's key, until the target is met
 */
export interface RendererWalk {
	resolver: AssetResolver;
	/** the pose drawn, `null` for the saved one */
	pose: PrefabPose | null;
	/** the unit quad billboard particle systems draw, or `null` to skip them */
	particleQuad: ObjectRef | null;
	/** whether the placement starts locked ({@link readUnlockConfig}) */
	locked: boolean;
	/** what picks the effect LOD tables' bands */
	effectLod: EffectLodSource;
	/** in walk order, which the renderers keep */
	candidates: RendererCandidate[];
	/** by Transform, its prefab-space matrix */
	transforms: Map<string, Float32Array>;
	/** every Transform in walk order (parents first), for posing them at each frame of a looping clip */
	nodes: PosedNode[];
	/** by candidate, its GameObject's Transform, for moving the candidates under a follower */
	candidateTransforms: Map<RendererCandidate, string>;
	/** by mesh renderer, its GameObject's Transform: what moves it when a looping clip turns that Transform */
	rendererTransforms: Map<string, string>;
	/** by renderer, the screen-relative heights an enabled LODGroup shows it at */
	lodSizes: Map<string, SizeRange[]>;
	/** GameObjects a view-state controller switches on to play an effect */
	played: Set<string>;
	/** GameObjects an EffectSetting's LOD table switches */
	lodSwitched: Set<string>;
	/**
	 * by GameObject, whether the root's `UnlockEffectConfigMono` shows that model of its own, `null` where it
	 * leaves the model as saved
	 */
	lockModels: Map<string, boolean | null>;
	/** Transforms a component of the root shows only while its interactive moves, so never at rest */
	movingOnly: Set<string>;
	/**
	 * by GameObject, the distances an EffectSetting's distance LOD leaves it on at and that setting's
	 * GameObject
	 */
	distanceSwitched: Map<string, { ranges: DistanceRange[]; setting: string }>;
	/** by GameObject, the LOD proxy levels the root's effect LOD table leaves it on at, as a mask */
	proxySwitched: Map<string, number>;
	/**
	 * by GameObject with a distance LOD, its position in prefab space: where the camera's distance is measured
	 * from
	 */
	settingOrigins: Map<string, [number, number, number]>;
	/** by Transform, the local scale a length the pose sets gives it */
	lengthScales: Map<string, [number, number, number]>;
	/** by renderer, the textures whose tiling follows a length the pose sets */
	lengthTilings: Map<string, ScaledTiling[]>;
	/** by renderer, the emission colours an enabled `AnimationProperties_Emissive` writes to it */
	emissiveOverrides: Map<string, EmissiveColors>;
	/** by `PositionFollower` Transform, the Transform whose position it takes */
	followers: Map<string, string>;
	/** by component, the active and enabled force fields */
	forceFields: Map<string, PlacedForceField>;
	/** by candidate, the played systems whose force fields are resolved after the walk */
	pendingForces: Map<RendererCandidate, PendingForces>;
	/** the played systems simulated in world space, whose particles stay where a moving emitter left them */
	worldSimulated: Set<RendererCandidate>;
}

/**
 * @param resolver bundle reader
 * @param options what `readPrefabRenderers` draws
 * @returns an empty walk
 */
export const createRendererWalk = (
	resolver: AssetResolver,
	options: Pick<RendererWalk, 'pose' | 'particleQuad' | 'locked' | 'effectLod'>,
): RendererWalk => ({
	resolver,
	...options,
	candidates: [],
	transforms: new Map(),
	nodes: [],
	candidateTransforms: new Map(),
	rendererTransforms: new Map(),
	lodSizes: new Map(),
	played: new Set(),
	lodSwitched: new Set(),
	lockModels: new Map(),
	movingOnly: new Set(),
	distanceSwitched: new Map(),
	proxySwitched: new Map(),
	settingOrigins: new Map(),
	lengthScales: new Map(),
	lengthTilings: new Map(),
	emissiveOverrides: new Map(),
	followers: new Map(),
	forceFields: new Map(),
	pendingForces: new Map(),
	worldSimulated: new Set(),
});

/**
 * how a GameObject is switched off: `standIn` names why for a subtree drawn as stand-ins, and is `null` for
 * one the pose switches off, which draws nothing
 */
export interface SwitchedOff {
	standIn: string | null;
}

/** an Animator above a GameObject */
export interface AnimatorScope {
	/** binding paths below the Animator its clips never show ({@link animatorHiddenNodes}) */
	hidden: ReadonlySet<number>;
	/** the GameObject's path below the Animator, `/`-joined; '' for the Animator's own */
	path: string;
}

/** what a GameObject hands its children in the renderer walk */
export interface RendererScope {
	/** how it's switched off, `null` when it's drawn */
	off: SwitchedOff | null;
	/** the billboard on it or its nearest ancestor with one */
	billboard: PrefabBillboard | null;
	/** its paths below the pose's Animators */
	paths: ClipPaths;
	/** the Animators at or above it: what their clips never show, and its path below each */
	scopes: readonly AnimatorScope[];
	/** the distances it shows at, `null` for any */
	distances: DistanceBands | null;
	/** the LOD proxy levels it shows at, as a mask; `null` for any */
	proxyLevels: number | null;
}

/** a GameObject's state in the renderer walk */
export interface RendererNode extends RendererScope {
	/** why it's a stand-in, `null` when it draws as the game does or not at all */
	standIn: string | null;
	/** whether it draws, as itself or as a stand-in */
	drawn: boolean;
	scopes: AnimatorScope[];
	/**
	 * the local transform its matrix composes, the saved one scaled by the pose's lengths and then posed; on
	 * the root, whose placement is the caller's, the identity scaled
	 */
	local: LocalTransform;
	/** material values the pose's clips leave on its renderers */
	posedMaterials: ClipMaterialValue[];
	/** the pose's looping clips that keep changing its renderers' material values */
	playedMaterials: PlayedMaterials[];
	/** other renderer values the pose's clips leave on its renderers, by attribute */
	posedRenderer: Map<number, number>;
	/** whether an EffectSetting on it switches by distance, measured from it */
	distanceOrigin: boolean;
}

/** what the root enters the walk under */
export const ABOVE_ROOT: RendererScope = {
	off: null,
	billboard: null,
	paths: [],
	scopes: [],
	distances: null,
	proxyLevels: null,
};

// #endregion

// #region switching off

/**
 * @returns how a GameObject whose parent is drawn is switched off, `null` when it's drawn. a switched-off
 *   subtree draws only stand-ins, since a script or view state can switch it on, unless the pose or lock
 *   switched it off (that pose's other states are placed on their own) or the pose is closed. skinned meshes
 *   can still use its transforms as bones
 */
const switchedOff = async (
	walk: RendererWalk,
	node: PrefabNode,
	paths: ClipPaths,
	scopes: readonly AnimatorScope[],
): Promise<SwitchedOff | null> => {
	const lockShown = walk.lockModels.get(node.key);
	if (lockShown !== undefined) {
		// only the lock switches these models, so one it leaves off never shows
		return (lockShown ?? node.active) ? null : { standIn: null };
	}
	// the interactive's logic keeps these off while it stands still, whatever the prefab saved
	if (walk.movingOnly.has(node.transformKey)) {
		return { standIn: null };
	}
	const clips = walk.pose?.clips ?? [];
	let posed = walk.pose?.active.get(node.name);
	// a settled clip that switches GameObjects owns its subtree's activity: what it leaves off stays off
	let switching = false;
	for (const [i, clip] of clips.entries()) {
		const path = paths[i];
		if (path !== null && path !== '') {
			posed = clip.active.get(bindingKey(path)) ?? posed;
			switching ||= clip.active.size > 0;
		}
	}
	if (posed === false || (posed === undefined && switching && !node.active)) {
		return { standIn: null };
	}
	if (posed !== undefined || node.active) {
		return null;
	}
	// an EffectSetting's LOD table can list its own GameObject, which its reader finds too late
	for (const setting of node.behaviours(isEffectSettingType)) {
		if ((await effectLodNodes(walk.resolver, setting.ref, await setting.read())).has(node.key)) {
			walk.lodSwitched.add(node.key);
		}
	}
	// a one-shot effect a view state plays shows for a moment, never at rest; what the prefab's own Animator,
	// or an effect's LOD table outside a view state, only ever holds off never shows
	const neverShown =
		scopes.some((scope) => scope.hidden.has(bindingKey(scope.path))) ||
		(walk.lodSwitched.has(node.key) && !walk.played.has(node.key));
	if (neverShown || (walk.played.has(node.key) && (await isOneShotEffect(walk.resolver, node.go)))) {
		return { standIn: null };
	}
	if (walk.pose?.closed === true && !walk.played.has(node.key)) {
		return { standIn: null };
	}
	return { standIn: 'switched off until a script or view state turns it on' };
};

// #endregion

// #region component readers

/**
 * reads one kind of component as its GameObject is entered, before it's placed: for what it does to other
 * GameObjects (switching, scaling, tinting), to its subtree, or to its own pose
 */
interface ComponentReader {
	accepts(component: PrefabComponent): boolean;
	read(walk: RendererWalk, node: PrefabNode, state: RendererNode, component: PrefabComponent): Promise<void>;
}

/** whether a MonoBehaviour is an `UnlockEffectConfigMono`, which swaps a model's locked and unlocked looks */
const isUnlockEffectConfigType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return names.has('useDifferentModel') && names.has('lockedModel') && names.has('unlockedModel');
};

const behaviourOf =
	(isType: (ref: ObjectRef) => boolean) =>
	(component: PrefabComponent): boolean =>
		component.classId === UnityClass.MonoBehaviour && isType(component.ref);

/** `VFXAdjustLength`: the Transforms and texture tilings a length the pose sets stretches */
const readAdjustLengthComponent: ComponentReader = {
	accepts: behaviourOf(isAdjustLengthType),
	async read(walk, node, _, component) {
		const length = walk.pose?.lengths?.get(node.name);
		if (length === undefined) {
			return;
		}
		const adjust = readAdjustLength(await component.read());
		if (adjust.unread.length > 0) {
			throw new FormatError(`VFXAdjustLength ${adjust.unread.join(', ')} aren't read`);
		}
		for (const pointer of adjust.scaleTargets) {
			const target = await walk.resolver.resolve(component.ref, pointer);
			if (target === null) {
				continue;
			}
			if (walk.transforms.has(objectKey(target))) {
				throw new FormatError(`VFXAdjustLength on ${node.name} scales a Transform drawn before it`);
			}
			walk.lengthScales.set(objectKey(target), lengthScale(adjust, length));
		}
		for (const tiling of adjust.tilings) {
			const renderer = await walk.resolver.resolve(component.ref, tiling.renderer);
			if (renderer !== null) {
				walk.lengthTilings
					.getOrInsertComputed(objectKey(renderer), () => [])
					.push({ tiling, ratio: length / adjust.preset });
			}
		}
	},
};

/** `UnlockEffectConfigMono` on the root: which of its models a lock leaves on */
const readUnlockConfig: ComponentReader = {
	accepts: behaviourOf(isUnlockEffectConfigType),
	async read(walk, node, _, component) {
		// the game looks it up on the model's root only, and acts on it whether or not it's enabled
		if (!node.isRoot) {
			return;
		}
		const config = await component.read();
		if (!booleanField(config, 'useDifferentModel')) {
			return;
		}
		const lockedModel = await walk.resolver.resolve(component.ref, pptrField(config, 'lockedModel'));
		const unlockedModel = await walk.resolver.resolve(component.ref, pptrField(config, 'unlockedModel'));
		if (unlockedModel !== null) {
			walk.lockModels.set(objectKey(unlockedModel), walk.locked ? false : null);
		}
		if (lockedModel !== null) {
			walk.lockModels.set(objectKey(lockedModel), walk.locked ? true : null);
		}
	},
};

/** the fields of `InteractiveSummonTeamPostmodelMono` that hold a raft's bow and stern wakes */
const RAFT_WAKE_ROOTS = ['headAnchorRoot', 'tailAnchorRoot'] as const;

/** whether a MonoBehaviour is an `InteractiveSummonTeamPostmodelMono`, the bamboo raft's post-model */
const isRaftPostmodelType = (ref: ObjectRef): boolean => {
	const names = new Set(ref.info.type?.nodes.filter((node) => node.level === 1).map((node) => node.name));
	return RAFT_WAKE_ROOTS.every((name) => names.has(name)) && names.has('decalHeadRoot');
};

/**
 * `InteractiveSummonTeamPostmodelMono` on the root: the wakes the raft's logic switches on only while it
 * moves (`docs/game-data/interactives.md#bamboo-rafts`)
 */
const readRaftPostmodel: ComponentReader = {
	accepts: behaviourOf(isRaftPostmodelType),
	async read(walk, node, _, component) {
		if (!node.isRoot) {
			return;
		}
		const data = await component.read();
		for (const name of RAFT_WAKE_ROOTS) {
			const root = await walk.resolver.resolve(component.ref, pptrField(data, name));
			if (root !== null) {
				walk.movingOnly.add(objectKey(root));
			}
		}
	},
};

/** `AnimationProperties_Emissive`: the emission colours it writes to its renderers */
const readEmissiveOverrideComponent: ComponentReader = {
	accepts: behaviourOf(isEmissiveOverrideType),
	async read(walk, node, state, component) {
		// it starts playing when enabled, so only an active, enabled one sets the colours at rest
		if (state.off !== null) {
			return;
		}
		const data = await component.read();
		if (!booleanField(data, 'm_Enabled')) {
			return;
		}
		const { renderers, colors: saved } = readEmissiveOverride(data);
		// a config the pose's view states apply replaces the saved colours
		const configs = walk.pose?.emissive;
		const config = (node.isRoot ? configs?.get(ROOT_EMISSIVE) : undefined) ?? configs?.get(node.name);
		for (const pointer of renderers) {
			const renderer = await walk.resolver.resolve(component.ref, pointer);
			if (renderer !== null) {
				walk.emissiveOverrides.set(objectKey(renderer), config ?? saved);
			}
		}
	},
};

/** a view-state controller: the effects its states switch on, found before their subtrees */
const readViewStateController: ComponentReader = {
	accepts: behaviourOf(isViewStateControllerType),
	async read(walk, _, __, component) {
		for (const node of await playedEffectNodes(walk.resolver, component.ref, await component.read())) {
			walk.played.add(node);
		}
	},
};

/** `EffectSetting`: what its LOD table switches, and by what camera distance or LOD proxy level */
const readEffectSetting: ComponentReader = {
	accepts: behaviourOf(isEffectSettingType),
	async read(walk, node, state, component) {
		const data = await component.read();
		for (const switched of await effectLodNodes(walk.resolver, component.ref, data)) {
			walk.lodSwitched.add(switched);
		}
		if (walk.effectLod === 'proxy') {
			// the dynamic scene drives only the root's setting, by its LOD proxy
			const byLevel = node.isRoot ? await effectProxyBands(walk.resolver, component.ref, data) : null;
			for (const [switched, levels] of byLevel ?? []) {
				walk.proxySwitched.set(switched, levels);
			}
			return;
		}
		const byDistance = await effectDistanceLod(walk.resolver, component.ref, data);
		if (byDistance === null) {
			return;
		}
		state.distanceOrigin = true;
		const switchByDistance = (key: string, ranges: DistanceRange[]): void => {
			const known = walk.distanceSwitched.get(key);
			// under nested tables, the later (inner) setting's origin
			walk.distanceSwitched.set(key, {
				ranges: known === undefined ? ranges : intersectRanges(known.ranges, ranges),
				setting: node.key,
			});
		};
		switchByDistance(node.key, byDistance.self);
		for (const [switched, ranges] of byDistance.nodes) {
			switchByDistance(switched, ranges);
		}
	},
};

/** an Animator: the GameObjects below it its clips never show */
const readAnimator: ComponentReader = {
	accepts: (component) => component.classId === UnityClass.Animator,
	async read(walk, _, state, component) {
		const hidden = await animatorHiddenNodes(walk.resolver, component.ref, await component.read());
		if (hidden.size > 0) {
			state.scopes.push({ hidden, path: '' });
		}
	},
};

/** each component goes to the first reader that accepts it */
const COMPONENT_READERS: readonly ComponentReader[] = [
	readAdjustLengthComponent,
	readUnlockConfig,
	readRaftPostmodel,
	readEmissiveOverrideComponent,
	readViewStateController,
	readEffectSetting,
	readAnimator,
];

// #endregion

// #region entering

/** @returns the renderer values a pose's clips leave on a GameObject */
const posedRendererValues = (
	pose: PrefabPose | null,
	paths: ClipPaths,
): Pick<RendererNode, 'posedMaterials' | 'playedMaterials' | 'posedRenderer'> => {
	const posedMaterials: ClipMaterialValue[] = [];
	const playedMaterials: PlayedMaterials[] = [];
	const posedRenderer = new Map<number, number>();
	for (const [i, clip] of (pose?.clips ?? []).entries()) {
		const path = paths[i];
		if (path === null) {
			continue;
		}
		const binding = bindingKey(path);
		const materials = clip.materials.get(binding);
		if (materials !== undefined) {
			posedMaterials.push(...materials);
			if (clip.motion !== null && clip.motion.loops && clip.motion.materials !== null) {
				playedMaterials.push({ motion: clip.motion, binding });
			}
		}
		for (const [attribute, value] of clip.renderers.get(binding) ?? []) {
			posedRenderer.set(attribute, value);
		}
	}
	return { posedMaterials, playedMaterials, posedRenderer };
};

/**
 * records a GameObject's Transform for posing it again at each frame of a looping clip
 *
 * @returns the local transform its matrix composes ({@link RendererNode.local})
 */
const localTransform = (walk: RendererWalk, node: PrefabNode, paths: ClipPaths): LocalTransform => {
	const base: LocalTransform = node.isRoot
		? { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }
		: node.saved;
	const scaled = { ...base, scale: walk.lengthScales.get(node.transformKey) ?? base.scale };
	walk.nodes.push({
		key: node.transformKey,
		parent: node.parent?.transformKey ?? null,
		saved: { ...scaled },
		below: paths,
	});
	if (node.isRoot) {
		return scaled;
	}
	return posedLocal(
		scaled,
		(walk.pose?.clips ?? []).map((clip) => clip.transforms),
		paths,
	);
};

const enterNode = async (
	walk: RendererWalk,
	node: PrefabNode,
	parent: RendererScope,
): Promise<RendererNode> => {
	const paths = clipPaths(walk.pose?.clips ?? [], parent.paths, node);
	const scopes = parent.scopes.map((scope) => ({
		hidden: scope.hidden,
		path: scope.path === '' ? node.name : `${scope.path}/${node.name}`,
	}));
	const off = parent.off ?? (await switchedOff(walk, node, paths, scopes));
	const standIn = off?.standIn ?? null;
	const state: RendererNode = {
		off,
		standIn,
		drawn: off === null || standIn !== null,
		billboard: parent.billboard,
		paths,
		scopes,
		distances: parent.distances,
		proxyLevels: parent.proxyLevels,
		local: node.saved,
		...posedRendererValues(walk.pose, paths),
		distanceOrigin: false,
	};
	for (const component of node.components) {
		await COMPONENT_READERS.find((reader) => reader.accepts(component))?.read(walk, node, state, component);
	}
	// after the readers, since the root's table can list the root
	const levels = walk.proxySwitched.get(node.key);
	if (levels !== undefined) {
		state.proxyLevels = (state.proxyLevels ?? ALL_PROXY_LEVELS) & levels;
	}
	// after the readers, since a VFXAdjustLength can scale its own Transform
	state.local = localTransform(walk, node, paths);
	return state;
};

// #endregion

// #region placement steps

/** what a GameObject's components do once its matrix is known, or what it draws */
export type NodeStep = (
	walk: RendererWalk,
	node: PlacedPrefabNode,
	state: RendererNode,
) => void | Promise<void>;

/** `PositionFollower`: the Transform it moves its GameObject to, once the whole hierarchy is placed */
const recordFollower: NodeStep = async (walk, node) => {
	let source: ObjectRef | null = null;
	for (const follower of node.behaviours(isPositionFollowerType)) {
		const data = await follower.read();
		if (booleanField(data, 'm_Enabled')) {
			source = await walk.resolver.resolve(follower.ref, pptrField(data, 'source'));
		}
	}
	// its source can come later in the walk
	if (source !== null && !node.isRoot) {
		walk.followers.set(node.transformKey, objectKey(source));
	}
};

/** active, enabled particle force fields, which played systems look up after the walk */
const placeForceFields: NodeStep = async (walk, node, state) => {
	if (state.off !== null) {
		return;
	}
	for (const field of node.ofClass(UnityClass.ParticleSystemForceField)) {
		const data = await field.read();
		if (booleanField(data, 'm_Enabled')) {
			walk.forceFields.set(objectKey(field.ref), {
				data,
				layer: optionalNumberField(node.data, 'm_Layer') ?? 0,
				matrix: node.matrix,
			});
		}
	}
};

/** the camera distances it shows at, measured from the EffectSetting that switches it */
const placeDistances: NodeStep = (walk, node, state) => {
	if (state.distanceOrigin) {
		walk.settingOrigins.set(node.key, [node.matrix[12], node.matrix[13], node.matrix[14]]);
	}
	const own = walk.distanceSwitched.get(node.key);
	// a setting is placed before what it switches, so its origin is known
	const origin = own && walk.settingOrigins.get(own.setting);
	if (own !== undefined && origin !== undefined) {
		// under nested tables, the inner table's origin with both tables' ranges
		state.distances = {
			ranges: state.distances === null ? own.ranges : intersectRanges(state.distances.ranges, own.ranges),
			origin,
		};
	}
};

/** `VFXBillBoard`: it sets its GameObject's world rotation, so the nearest one up the hierarchy wins */
const placeBillboard: NodeStep = async (_, node, state) => {
	const board = node.behaviours(isBillboardType).at(-1);
	if (state.drawn && board !== undefined) {
		state.billboard = readBillboard(await board.read(), node.matrix) ?? state.billboard;
	}
};

const PLACEMENT_STEPS: readonly NodeStep[] = [
	recordFollower,
	placeForceFields,
	placeDistances,
	placeBillboard,
];

const placeNode = async (walk: RendererWalk, node: PlacedPrefabNode, state: RendererNode): Promise<void> => {
	walk.transforms.set(node.transformKey, node.matrix);
	const first = walk.candidates.length;
	for (const step of PLACEMENT_STEPS) {
		await step(walk, node, state);
	}
	if (state.drawn) {
		for (const source of CANDIDATE_SOURCES) {
			await source(walk, node, state);
		}
	}
	for (const candidate of walk.candidates.slice(first)) {
		walk.candidateTransforms.set(candidate, node.transformKey);
	}
};

// #endregion

/**
 * @param walk what the walk collects into
 * @returns the visitor that collects a prefab's renderers into the walk, starting from {@link ABOVE_ROOT}
 */
export const rendererVisitor = (walk: RendererWalk): PrefabVisitor<RendererNode, RendererScope> => ({
	enter: (node, parent) => enterNode(walk, node, parent),
	local: (_, state) => state.local,
	visit: (node, state) => placeNode(walk, node, state),
});
