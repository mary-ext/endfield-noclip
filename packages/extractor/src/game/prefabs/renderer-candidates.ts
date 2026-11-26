/* oxlint-disable no-await-in-loop -- reads a GameObject's renderers in authored order */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { multiplyMatrices } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	aabbField,
	arrayField,
	booleanField,
	isObject,
	numberField,
	objectField,
	pptrField,
	vector3Field,
} from '@endfield-noclip/formats/unity/values';
import { ChainFlags } from '@endfield-noclip/package-format/instances';
import { ParticleRenderMode } from '@endfield-noclip/package-format/particles';

import { loadMesh } from '../assets/asset-decode.ts';
import { objectKey, type ObjectRef } from '../assets/assets.ts';
import {
	frozenParticleMatrix,
	meshParticlePivot,
	particleEmitterMatrix,
	particleMeshSize,
	particleStandInMatrix,
} from '../effects/particle-mesh.ts';
import {
	type ParticleSystemRead,
	particleShapeMesh,
	readParticleSystem,
	ScalingMode,
	SimulationSpace,
} from '../effects/particle-system.ts';
import { isSplineMoverType, splineMoverRenderers } from '../effects/spline-movers.ts';

import { DECAL_PROJECTOR_CLASS, readDecalProjector } from './decal-projector.ts';
import { LINE_RENDERER_CLASS, readLineRenderer } from './line-renderer.ts';
import { parentFrame, type PlacedPrefabNode, type PrefabComponent } from './prefab-walk.ts';
import type { NodeStep, RendererCandidate, RendererNode, RendererWalk } from './renderer-walk.ts';

// what a drawn GameObject of the renderer walk draws, in the order its renderers are kept: LODGroup heights
// first, then skinned meshes, mesh renderers, decal projectors, the particle system and spline movers

/** Unity's class id of LODGroup */
const LOD_GROUP = 205;

/** a ParticleSystemRenderer's `m_Pivot` components as clip bindings name them */
const PIVOT_ATTRIBUTES = ['x', 'y', 'z'].map((axis) => crc32(`m_Pivot.${axis}`) >>> 0);

/** a component with its fields */
interface ReadComponent {
	ref: ObjectRef;
	data: TypeTreeObject;
}

/** @returns the component's fields when it's enabled, else `null` */
const enabledData = async (component: PrefabComponent): Promise<TypeTreeObject | null> => {
	const data = await component.read();
	return booleanField(data, 'm_Enabled') ? data : null;
};

/** @returns a candidate of the GameObject, with what all of its candidates share */
const candidateOf = (
	node: PlacedPrefabNode,
	state: RendererNode,
	fields: Omit<
		RendererCandidate,
		'name' | 'synthetic' | 'posedMaterials' | 'playedMaterials' | 'avatarBones' | 'distances' | 'proxyLevels'
	> & { synthetic?: RendererCandidate['synthetic'] },
): RendererCandidate => ({
	...fields,
	synthetic: fields.synthetic ?? null,
	name: node.name,
	posedMaterials: state.posedMaterials,
	playedMaterials: state.playedMaterials,
	avatarBones: state.avatarBones,
	distances: state.distances,
	proxyLevels: state.proxyLevels,
});

/** an enabled LODGroup's renderers, with the screen-relative heights it shows each at */
const collectLodSizes: NodeStep = async (walk, node) => {
	for (const group of node.ofClass(LOD_GROUP)) {
		const data = await enabledData(group);
		if (data === null) {
			continue;
		}
		// read LODGroup reference sphere (m_LocalReferencePoint + m_Size) transformed into prefab-root space
		let lodRef: { center: [number, number, number]; size: number } | null = null;
		const rawSize = typeof data.m_Size === 'number' ? data.m_Size : 0;
		if (rawSize > 0) {
			const localCenter = isObject(data.m_LocalReferencePoint)
				? vector3Field(data, 'm_LocalReferencePoint')
				: ([0, 0, 0] as [number, number, number]);
			const m = node.matrix;
			const center: [number, number, number] = [
				m[0] * localCenter[0] + m[4] * localCenter[1] + m[8] * localCenter[2] + m[12],
				m[1] * localCenter[0] + m[5] * localCenter[1] + m[9] * localCenter[2] + m[13],
				m[2] * localCenter[0] + m[6] * localCenter[1] + m[10] * localCenter[2] + m[14],
			];
			const scale = Math.max(
				Math.hypot(m[0], m[1], m[2]),
				Math.hypot(m[4], m[5], m[6]),
				Math.hypot(m[8], m[9], m[10]),
			);
			if (scale > 0) {
				lodRef = { center, size: rawSize * scale };
			}
		}
		// LOD i shows while the screen-relative height is in (its threshold, the previous LOD's]
		let upper = Infinity;
		for (const [lod, value] of arrayField(data, 'm_LODs').entries()) {
			if (!isObject(value)) {
				throw new FormatError('invalid prefab LOD');
			}
			const threshold = numberField(value, 'screenRelativeHeight');
			for (const renderer of arrayField(value, 'renderers')) {
				if (!isObject(renderer)) {
					throw new FormatError('invalid prefab LOD renderer');
				}
				const ref = await walk.resolver.resolve(group.ref, pptrField(renderer, 'renderer'));
				if (ref !== null) {
					const rKey = objectKey(ref);
					const ranges = walk.lodSizes.getOrInsertComputed(rKey, () => []);
					// a renderer in consecutive LODs shows across all of them
					const last = ranges.at(-1);
					if (last !== undefined && last.min === upper) {
						last.min = threshold;
					} else {
						ranges.push({ lod, min: threshold, max: upper });
					}
					if (lodRef !== null && !walk.lodGroups.has(rKey)) {
						walk.lodGroups.set(rKey, lodRef);
					}
				}
			}
			upper = threshold;
		}
	}
};

const collectSkinnedRenderers: NodeStep = async (walk, node, state) => {
	for (const renderer of node.ofClass(UnityClass.SkinnedMeshRenderer)) {
		const data = await enabledData(renderer);
		const mesh = data && (await walk.resolver.resolve(renderer.ref, pptrField(data, 'm_Mesh')));
		if (data !== null && mesh !== null) {
			walk.candidates.push(
				candidateOf(node, state, {
					ref: renderer.ref,
					data,
					matrix: node.matrix,
					mesh,
					particles: null,
					unsupported: state.standIn,
					ownSize: false,
					billboard: null,
					decal: null,
				}),
			);
		}
	}
};

const collectMeshRenderers: NodeStep = async (walk, node, state) => {
	const [filter] = node.ofClass(UnityClass.MeshFilter);
	if (filter === undefined) {
		return;
	}
	const mesh = await walk.resolver.resolve(filter.ref, pptrField(await filter.read(), 'm_Mesh'));
	if (mesh === null) {
		return;
	}
	for (const renderer of node.ofClass(UnityClass.MeshRenderer)) {
		const data = await enabledData(renderer);
		if (data === null) {
			continue;
		}
		walk.rendererTransforms.set(objectKey(renderer.ref), node.transformKey);
		walk.candidates.push(
			candidateOf(node, state, {
				ref: renderer.ref,
				data,
				matrix: node.matrix,
				mesh,
				particles: null,
				unsupported: state.standIn,
				ownSize: false,
				billboard: state.billboard,
				decal: null,
			}),
		);
	}
};

/**
 * enabled `HGDecalProjector`s: the decal cube in the GameObject's box, with the projector's placement. the
 * box stays where the prefab saved it, even under a Transform a looping clip moves
 */
const collectDecalProjectors: NodeStep = async (walk, node, state) => {
	if (walk.decalCube === null) {
		return;
	}
	for (const projector of node.ofClass(DECAL_PROJECTOR_CLASS)) {
		const data = await enabledData(projector);
		if (data === null) {
			continue;
		}
		const { decal, unsupported } = readDecalProjector(data);
		walk.candidates.push(
			candidateOf(node, state, {
				ref: projector.ref,
				data,
				matrix: node.matrix,
				mesh: walk.decalCube,
				particles: null,
				unsupported: state.standIn ?? unsupported,
				ownSize: false,
				billboard: null,
				decal,
			}),
		);
	}
};

// #region particles

/** @returns the renderer's fields with the pivot the pose moves it to; a copy keeps the cached ones as saved */
const posedPivot = (data: TypeTreeObject, posedRenderer: ReadonlyMap<number, number>): TypeTreeObject => {
	if (!PIVOT_ATTRIBUTES.some((attribute) => posedRenderer.has(attribute))) {
		return data;
	}
	const saved = objectField(data, 'm_Pivot');
	const [x, y, z] = PIVOT_ATTRIBUTES.map(
		(attribute, i) => posedRenderer.get(attribute) ?? numberField(saved, 'xyz'[i]),
	);
	return { ...data, m_Pivot: { x, y, z } };
};

/** @returns a mesh particle system that holds still, frozen where its particles rest; `null` for any other */
const frozenParticles = async (
	walk: RendererWalk,
	node: PlacedPrefabNode,
	state: RendererNode,
	parts: { renderer: ReadComponent; system: ReadComponent; rendererData: TypeTreeObject },
): Promise<{ matrix: Float32Array; mesh: ObjectRef } | null> => {
	const { renderer, system, rendererData } = parts;
	if (numberField(rendererData, 'm_RenderMode') !== ParticleRenderMode.Mesh) {
		return null;
	}
	const mesh = await walk.resolver.resolve(renderer.ref, pptrField(renderer.data, 'm_Mesh'));
	if (mesh === null) {
		return null;
	}
	const meshSize = particleMeshSize(aabbField(await walk.resolver.read(mesh), 'm_LocalAABB'));
	const placed = frozenParticleMatrix(system.data, rendererData, parentFrame(node), state.local, meshSize);
	return placed === null ? null : { matrix: placed, mesh };
};

/** @returns the system as the viewer plays it, with its shape mesh loaded, or why it can't */
const readPlayedSystem = async (
	walk: RendererWalk,
	system: ReadComponent,
	rendererData: TypeTreeObject,
): Promise<ParticleSystemRead | null> => {
	const read = readParticleSystem(system.data, rendererData);
	if (read === null || !('info' in read) || read.shapeMesh === null) {
		return read;
	}
	const pending = read.shapeMesh;
	const shapeMesh = await walk.resolver.resolve(system.ref, pending.mesh);
	const mesh =
		shapeMesh === null
			? 'no shape mesh'
			: particleShapeMesh(objectField(system.data, 'ShapeModule'), await loadMesh(walk.resolver, shapeMesh));
	if (typeof mesh === 'string') {
		return { reason: mesh };
	}
	return { ...read, info: { ...read.info, shape: { ...pending.shape, mesh } }, shapeMesh: null };
};

/**
 * the enabled ParticleSystemRenderer and its system: frozen when it holds still, played when the viewer can
 * play it, else a stand-in where it would play
 */
const collectParticles: NodeStep = async (walk, node, state) => {
	let renderer: ReadComponent | undefined;
	for (const component of node.ofClass(UnityClass.ParticleSystemRenderer)) {
		const data = await enabledData(component);
		if (data !== null) {
			renderer = { ref: component.ref, data };
			break;
		}
	}
	const [systemComponent] = node.ofClass(UnityClass.ParticleSystem);
	if (renderer === undefined || systemComponent === undefined) {
		return;
	}
	const rawSystemData = await systemComponent.read();
	const adjustedDistance = walk.lengthLifetimes.get(objectKey(systemComponent.ref));
	let systemData = rawSystemData;
	if (adjustedDistance !== undefined) {
		// VFXAdjustLength._AdjustParticleSystemLifeTimes: startLifetime.constantMax = (offsetLength + length) / startSpeed.constantMax
		const initial = objectField(rawSystemData, 'InitialModule');
		const startSpeedMax = numberField(objectField(initial, 'startSpeed'), 'scalar');
		if (startSpeedMax > 0) {
			const startLifetime = objectField(initial, 'startLifetime');
			systemData = {
				...rawSystemData,
				InitialModule: {
					...initial,
					startLifetime: { ...startLifetime, scalar: adjustedDistance / startSpeedMax },
				},
			};
		}
	}
	const system = { ref: systemComponent.ref, data: systemData };
	// the renderer's second material is its trails' (Unity's `trailMaterial`), not another pass over the
	// particles' mesh as on a mesh renderer
	const materials = arrayField(renderer.data, 'm_Materials');
	const particleRenderer = {
		ref: renderer.ref,
		data: { ...renderer.data, m_Materials: materials.filter((_, i) => i !== 1) },
	};
	const trailMaterials = materials.slice(1, 2);
	const parent = parentFrame(node);
	const local = state.local;
	const rendererData = posedPivot(renderer.data, state.posedRenderer);
	// the placement's scale sizes stand-in and frozen particles only where the scaling mode keeps the scale
	// above the system: `Hierarchy`, or `Local` on the root, whose own scale the placement is
	const scalingMode = numberField(system.data, 'scalingMode');
	const ownSize = scalingMode === ScalingMode.Shape || (scalingMode === ScalingMode.Local && !node.isRoot);
	// a switched-off system stands in at its emitter whatever it would play
	if (state.standIn === null) {
		const frozen = await frozenParticles(walk, node, state, { renderer, system, rendererData });
		if (frozen !== null) {
			walk.candidates.push(
				candidateOf(node, state, {
					...particleRenderer,
					matrix: frozen.matrix,
					mesh: frozen.mesh,
					particles: null,
					unsupported: null,
					ownSize,
					billboard: null,
					decal: null,
				}),
			);
			return;
		}
	}
	const read = await readPlayedSystem(walk, system, rendererData);
	if (read !== null && 'empty' in read) {
		return;
	}
	const drawsParticles = numberField(rendererData, 'm_RenderMode') !== ParticleRenderMode.None;
	// a system a script starts is still there to see, so it gets a stand-in too
	let reason = state.standIn;
	if (reason === null && read === null) {
		reason = `doesn't play on awake`;
	} else if (reason === null && read !== null && 'reason' in read) {
		reason = read.reason;
	} else if (
		reason === null &&
		!drawsParticles &&
		trailMaterials.length === 0 &&
		(read === null || !('info' in read) || read.subEmitters.length === 0)
	) {
		reason = 'no trail material';
	}
	if (reason !== null) {
		// a stand-in shows where the system would play: its first mesh, or a quad facing the camera
		let mesh: ObjectRef | null = null;
		if (numberField(renderer.data, 'm_RenderMode') === ParticleRenderMode.Mesh) {
			mesh = await walk.resolver.resolve(renderer.ref, pptrField(renderer.data, 'm_Mesh'));
		}
		const quad = mesh === null;
		mesh ??= walk.particleQuad;
		if (mesh !== null) {
			const placed = particleStandInMatrix(parent, local, scalingMode);
			walk.candidates.push(
				candidateOf(node, state, {
					...particleRenderer,
					matrix: placed,
					mesh,
					particles: null,
					unsupported: reason,
					ownSize,
					billboard: quad ? { flag: ChainFlags.BillboardFacing, offset: [0, 0, 0, 1], frame: placed } : null,
					decal: null,
				}),
			);
		}
		return;
	}
	if (read === null || !('info' in read)) {
		return;
	}
	const emitter = particleEmitterMatrix(parent, local, scalingMode);
	// one emitter per mesh, each drawing the particles that picked it; quads have none of their own
	let meshes: (ObjectRef | null)[] = [];
	if (drawsParticles) {
		meshes =
			read.meshes.length === 0
				? [walk.particleQuad]
				: await Promise.all(read.meshes.map((pointer) => walk.resolver.resolve(renderer.ref, pointer)));
	}
	const candidates: RendererCandidate[] = [];
	for (const [i, mesh] of meshes.entries()) {
		if (mesh === null) {
			continue;
		}
		let pivot = read.info.pivot;
		if (read.info.renderMode === ParticleRenderMode.Mesh) {
			// mesh headers are cached by the resolver
			const bounds = aabbField(await walk.resolver.read(mesh), 'm_LocalAABB');
			pivot = meshParticlePivot(pivot, particleMeshSize(bounds));
		}
		candidates.push(
			candidateOf(node, state, {
				...particleRenderer,
				matrix: emitter,
				mesh,
				particles: { ...read.info, pivot, mesh: i },
				unsupported: null,
				ownSize: false,
				billboard: null,
				decal: null,
				...(i === 0 && read.droppedModules.length > 0 ? { droppedModules: read.droppedModules } : {}),
			}),
		);
	}
	if (read.trail !== null && trailMaterials.length > 0 && walk.particleQuad !== null) {
		// every particle's trail, whichever mesh it picked, as one strip of quads
		candidates.push(
			candidateOf(node, state, {
				ref: renderer.ref,
				data: { ...renderer.data, m_Materials: trailMaterials },
				matrix: emitter,
				mesh: walk.particleQuad,
				particles: { ...read.info, pivot: [0, 0, 0], trail: read.trail },
				unsupported: null,
				ownSize: false,
				billboard: null,
				decal: null,
			}),
		);
	} else if (read.trailGap !== null && trailMaterials.length > 0 && walk.particleQuad !== null) {
		// an enabled TrailModule that couldn't be simulated still stands in so it isn't silently dropped
		const placed = particleStandInMatrix(parent, local, scalingMode);
		candidates.push(
			candidateOf(node, state, {
				ref: renderer.ref,
				data: { ...renderer.data, m_Materials: trailMaterials },
				matrix: placed,
				mesh: walk.particleQuad,
				particles: null,
				unsupported: read.trailGap,
				ownSize,
				billboard: { flag: ChainFlags.BillboardFacing, offset: [0, 0, 0, 1], frame: placed },
				decal: null,
			}),
		);
	}
	walk.particleSystems.set(objectKey(system.ref), {
		ref: system.ref,
		info: read.info,
		emitter,
		candidates,
		subEmitters: read.subEmitters,
	});
	for (const candidate of candidates) {
		walk.candidates.push(candidate);
		// a custom simulation space's Transform is taken to hold still, as the world does
		if (numberField(system.data, 'moveWithTransform') !== SimulationSpace.Local) {
			walk.worldSimulated.add(candidate);
		}
		if (read.forces !== null) {
			walk.pendingForces.set(candidate, {
				system: system.ref,
				forces: read.forces,
				emitter,
				standIn: particleStandInMatrix(parent, local, scalingMode),
			});
		}
	}
};

// #endregion

/**
 * enabled `HGSplineMovingObjects`: their objects draw their LOD groups' first-LOD renderers, from other
 * prefabs
 */
const collectSplineMovers: NodeStep = async (walk, node, state) => {
	for (const mover of node.behaviours(isSplineMoverType)) {
		const data = await enabledData(mover);
		if (data === null) {
			continue;
		}
		for (const renderer of await splineMoverRenderers(walk.resolver, mover.ref, data, state.standIn)) {
			walk.candidates.push({
				...renderer,
				synthetic: null,
				matrix: node.matrix,
				name: node.name,
				ownSize: false,
				billboard: null,
				decal: null,
				posedMaterials: [],
				playedMaterials: [],
				avatarBones: null,
				distances: state.distances,
				proxyLevels: state.proxyLevels,
			});
		}
	}
};

/** enabled local-space `LineRenderer`s, baked into synthetic ribbon runs */
const collectLineRenderers: NodeStep = async (walk, node, state) => {
	for (const line of node.ofClass(LINE_RENDERER_CLASS)) {
		const data = await enabledData(line);
		if (data === null) {
			continue;
		}
		for (const run of readLineRenderer(data)) {
			const matrix = multiplyMatrices(node.matrix, run.matrix);
			walk.candidates.push(
				candidateOf(node, state, {
					ref: line.ref,
					data,
					matrix,
					mesh: null,
					synthetic: { mesh: run.mesh, bounds: run.bounds },
					particles: null,
					unsupported: state.standIn,
					ownSize: false,
					billboard: run.axial
						? { flag: ChainFlags.BillboardAxial, offset: [0, 0, 0, 1], frame: matrix }
						: state.billboard,
					decal: null,
				}),
			);
		}
	}
};

/** Unity Renderer subclasses that have no dedicated collector yet, mapped to their class name */
const UNHANDLED_RENDERER_CLASSES = new Map<number, string>([
	[96, 'TrailRenderer'],
	[212, 'SpriteRenderer'],
	[227, 'BillboardRenderer'],
	[483693784, 'TilemapRenderer'],
	[1971053207, 'SpriteShapeRenderer'],
]);

/** a registered prefab renderer collector and the Unity class IDs it claims */
export interface RendererHandler {
	name: string;
	/** Unity class IDs claimed by this handler (excluded from the unhandled-renderer stand-in fallback) */
	classes: readonly number[];
	step: NodeStep;
}

/** registered prefab renderer collectors, run in authored candidate order */
export const RENDERER_HANDLERS: readonly RendererHandler[] = [
	{ name: 'lodGroup', classes: [LOD_GROUP], step: collectLodSizes },
	{ name: 'skinnedMesh', classes: [UnityClass.SkinnedMeshRenderer], step: collectSkinnedRenderers },
	{ name: 'mesh', classes: [UnityClass.MeshRenderer], step: collectMeshRenderers },
	{ name: 'decalProjector', classes: [DECAL_PROJECTOR_CLASS], step: collectDecalProjectors },
	{ name: 'lineRenderer', classes: [LINE_RENDERER_CLASS], step: collectLineRenderers },
	{ name: 'particleSystem', classes: [UnityClass.ParticleSystemRenderer], step: collectParticles },
	{ name: 'splineMover', classes: [], step: collectSplineMovers },
];

/** Unity classes claimed by a registered handler above */
const HANDLED_RENDERER_CLASSES = new Set<number>(RENDERER_HANDLERS.flatMap((handler) => handler.classes));

const STAND_IN_CUBE_BOUNDS = { center: [0, 0, 0], extents: [0.5, 0.5, 0.5] } as const;

/**
 * catches any enabled Unity `Renderer` subclass not claimed by a dedicated collector (known subclasses like
 * `TrailRenderer` / `SpriteRenderer`, or any custom engine Renderer whose TypeTree carries `m_Materials`) and
 * emits a stand-in cube so it never disappears silently
 */
const collectUnhandledRenderers: NodeStep = async (walk, node, state) => {
	for (const component of node.components) {
		const { classId } = component;
		if (HANDLED_RENDERER_CLASSES.has(classId) || classId === UnityClass.MonoBehaviour) {
			continue;
		}
		let className = UNHANDLED_RENDERER_CLASSES.get(classId);
		if (className === undefined) {
			const nodes = component.ref.info.type.nodes;
			if (!nodes.some((entry) => entry.name === 'm_Materials')) {
				continue;
			}
			className = nodes[0]?.type ?? `class ${classId}`;
		}
		const data = await enabledData(component);
		if (data === null) {
			continue;
		}
		walk.candidates.push(
			candidateOf(node, state, {
				ref: component.ref,
				data,
				matrix: node.matrix,
				mesh: null,
				synthetic: {
					mesh: 'cube',
					bounds: { center: [...STAND_IN_CUBE_BOUNDS.center], extents: [...STAND_IN_CUBE_BOUNDS.extents] },
				},
				particles: null,
				unsupported: state.standIn ?? `unhandled renderer ${className}`,
				ownSize: false,
				billboard: null,
				decal: null,
			}),
		);
	}
};

/** what a drawn GameObject draws, in the order its candidates are kept */
export const CANDIDATE_SOURCES: readonly NodeStep[] = [
	...RENDERER_HANDLERS.map((handler) => handler.step),
	collectUnhandledRenderers,
];
