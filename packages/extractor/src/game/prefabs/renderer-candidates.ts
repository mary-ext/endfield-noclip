/* oxlint-disable no-await-in-loop -- reads a GameObject's renderers in authored order */
import { crc32 } from 'node:zlib';

import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	aabbField,
	arrayField,
	booleanField,
	isObject,
	numberField,
	objectField,
	pptrField,
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

import type { PlacedPrefabNode, PrefabComponent } from './prefab-walk.ts';
import type { NodeStep, RendererCandidate, RendererNode, RendererWalk } from './renderer-walk.ts';

// what a drawn GameObject of the renderer walk draws, in the order its renderers are kept: LODGroup heights
// first, then skinned meshes, mesh renderers, the particle system and spline movers

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
		'name' | 'posedMaterials' | 'playedMaterials' | 'distances' | 'proxyLevels'
	>,
): RendererCandidate => ({
	...fields,
	name: node.name,
	posedMaterials: state.posedMaterials,
	playedMaterials: state.playedMaterials,
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
					const ranges = walk.lodSizes.getOrInsertComputed(objectKey(ref), () => []);
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
	const placed = frozenParticleMatrix(system.data, rendererData, node.parentMatrix, state.local, meshSize);
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
	const system = { ref: systemComponent.ref, data: await systemComponent.read() };
	const parent = node.parentMatrix;
	const local = state.local;
	const rendererData = posedPivot(renderer.data, state.posedRenderer);
	// the placement's scale sizes stand-in and frozen particles only where the scaling mode keeps the scale
	// above the system: `Hierarchy`, or `Local` on the root, whose own scale the placement is
	const scalingMode = numberField(system.data, 'scalingMode');
	const ownSize = scalingMode === ScalingMode.Shape || (scalingMode === ScalingMode.Local && !node.isRoot);
	// a switched-off system stands in at its emitter whatever it would play
	const frozen =
		state.standIn === null
			? await frozenParticles(walk, node, state, { renderer, system, rendererData })
			: null;
	if (frozen !== null) {
		walk.candidates.push(
			candidateOf(node, state, {
				...renderer,
				matrix: frozen.matrix,
				mesh: frozen.mesh,
				particles: null,
				unsupported: null,
				ownSize,
				billboard: null,
			}),
		);
		return;
	}
	const read = await readPlayedSystem(walk, system, rendererData);
	// a system a script starts is still there to see, so it gets a stand-in too
	let reason = state.standIn;
	if (reason === null && read === null) {
		reason = `doesn't play on awake`;
	} else if (reason === null && read !== null && 'reason' in read) {
		reason = read.reason;
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
					...renderer,
					matrix: placed,
					mesh,
					particles: null,
					unsupported: reason,
					ownSize,
					billboard: quad ? { flag: ChainFlags.BillboardFacing, offset: [0, 0, 0, 1], frame: placed } : null,
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
	const meshes =
		read.meshes.length === 0
			? [walk.particleQuad]
			: await Promise.all(read.meshes.map((pointer) => walk.resolver.resolve(renderer.ref, pointer)));
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
		const candidate = candidateOf(node, state, {
			...renderer,
			matrix: emitter,
			mesh,
			particles: { ...read.info, pivot, mesh: i },
			unsupported: null,
			ownSize: false,
			billboard: null,
		});
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
				matrix: node.matrix,
				name: node.name,
				ownSize: false,
				billboard: null,
				posedMaterials: [],
				playedMaterials: [],
				distances: state.distances,
				proxyLevels: state.proxyLevels,
			});
		}
	}
};

/** what a drawn GameObject draws, in the order its candidates are kept */
export const CANDIDATE_SOURCES: readonly NodeStep[] = [
	collectLodSizes,
	collectSkinnedRenderers,
	collectMeshRenderers,
	collectParticles,
	collectSplineMovers,
];
