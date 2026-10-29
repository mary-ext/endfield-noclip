/* oxlint-disable no-await-in-loop -- traverse in authored order with bounded bundle residency */
import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { multiplyMatrices, trsMatrix, transformBounds } from '@endfield-noclip/formats/unity/transform';
import type { TypeTreeObject } from '@endfield-noclip/formats/unity/type-tree';
import {
	aabbField,
	arrayField,
	asPPtr,
	booleanField,
	isObject,
	numberField,
	objectField,
	pptrField,
	stringField,
	type Aabb,
} from '@endfield-noclip/formats/unity/values';

import { objectKey, type AssetResolver, type ObjectRef } from './assets.ts';

/** one enabled mesh renderer in a prefab's highest-detail authored LOD */
export interface PrefabRenderer {
	name: string;
	matrix: Float32Array;
	bounds: Aabb;
	mesh: ObjectRef;
	materials: (ObjectRef | null)[];
	submeshes: number;
	shadowOnly: boolean;
	/** bone transforms including bind poses, when geometry must be baked into prefab space */
	pose: Float32Array[] | null;
}

const xyz = (value: TypeTreeObject): [number, number, number] => [
	numberField(value, 'x'),
	numberField(value, 'y'),
	numberField(value, 'z'),
];

/**
 * walks a prefab's active hierarchy and resolves renderer dependencies through their exact PPtrs. only the
 * first authored LOD is emitted; other LOD renderers are excluded by identity, never by name
 *
 * @param resolver bundle reader
 * @param root prefab GameObject
 * @returns enabled mesh renderers relative to the prefab root; the caller supplies the root placement
 * @throws {FormatError} on malformed hierarchy, missing references or unsupported renderer dependencies
 */
export const readPrefabRenderers = async (
	resolver: AssetResolver,
	root: ObjectRef,
): Promise<PrefabRenderer[]> => {
	const candidates: {
		ref: ObjectRef;
		data: TypeTreeObject;
		matrix: Float32Array;
		name: string;
		mesh: ObjectRef;
	}[] = [];
	const excluded = new Set<string>();
	const firstLod = new Set<string>();
	const seen = new Set<string>();
	const transforms = new Map<string, Float32Array>();
	const visit = async (go: ObjectRef, parent: Float32Array, isRoot: boolean): Promise<void> => {
		const key = objectKey(go);
		if (seen.has(key)) {
			throw new FormatError(`cyclic prefab hierarchy at ${key}`);
		}
		seen.add(key);
		const data = await resolver.read(go);
		if (!booleanField(data, 'm_IsActive')) {
			return;
		}
		const components: { ref: ObjectRef; data: TypeTreeObject }[] = [];
		for (const item of arrayField(data, 'm_Component')) {
			if (!isObject(item)) {
				throw new FormatError('prefab component is not an object');
			}
			const ref = await resolver.resolve(go, pptrField(item, 'component'));
			if (
				ref !== null &&
				[
					UnityClass.Transform,
					UnityClass.MeshFilter,
					UnityClass.MeshRenderer,
					UnityClass.SkinnedMeshRenderer,
					205,
				].includes(ref.info.classId)
			) {
				components.push({ ref, data: await resolver.read(ref) });
			}
		}
		const transform = components.find((component) => component.ref.info.classId === UnityClass.Transform);
		if (transform === undefined) {
			throw new FormatError(`prefab GameObject ${key} has no Transform`);
		}
		const t = transform.data;
		const rotation = objectField(t, 'm_LocalRotation');
		const matrix = isRoot
			? parent
			: multiplyMatrices(
					parent,
					trsMatrix(
						xyz(objectField(t, 'm_LocalPosition')),
						[...xyz(rotation), numberField(rotation, 'w')],
						xyz(objectField(t, 'm_LocalScale')),
					),
				);
		transforms.set(objectKey(transform.ref), matrix);
		for (const component of components) {
			if (component.ref.info.classId !== 205 || !booleanField(component.data, 'm_Enabled')) {
				continue;
			}
			for (const [lod, value] of arrayField(component.data, 'm_LODs').entries()) {
				if (!isObject(value)) {
					throw new FormatError('invalid prefab LOD');
				}
				for (const renderer of arrayField(value, 'renderers')) {
					if (!isObject(renderer)) {
						throw new FormatError('invalid prefab LOD renderer');
					}
					const ref = await resolver.resolve(component.ref, pptrField(renderer, 'renderer'));
					if (ref !== null) {
						(lod === 0 ? firstLod : excluded).add(objectKey(ref));
					}
				}
			}
		}
		for (const component of components) {
			if (
				component.ref.info.classId === UnityClass.SkinnedMeshRenderer &&
				booleanField(component.data, 'm_Enabled')
			) {
				const mesh = await resolver.resolve(component.ref, pptrField(component.data, 'm_Mesh'));
				if (mesh !== null) {
					candidates.push({ ...component, matrix, name: stringField(data, 'm_Name'), mesh });
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
						candidates.push({ ...component, matrix, name: stringField(data, 'm_Name'), mesh });
					}
				}
			}
		}
		for (const pointer of arrayField(t, 'm_Children')) {
			const child = await resolver.resolve(transform.ref, asPPtr(pointer));
			if (child !== null) {
				const childData = await resolver.read(child);
				const childGo = await resolver.resolve(child, pptrField(childData, 'm_GameObject'));
				if (childGo !== null) {
					await visit(childGo, matrix, false);
				}
			}
		}
	};
	await visit(root, trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]), true);
	const result: PrefabRenderer[] = [];
	for (const candidate of candidates) {
		const key = objectKey(candidate.ref);
		if (excluded.has(key) && !firstLod.has(key)) {
			continue;
		}
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
		let pose: Float32Array[] | null = null;
		if (candidate.ref.info.classId === UnityClass.SkinnedMeshRenderer) {
			if (arrayField(candidate.data, 'm_BlendShapeWeights').some((weight) => weight !== 0)) {
				throw new FormatError(`nonzero prefab blend shape in ${candidate.name}`);
			}
			const bones = arrayField(candidate.data, 'm_Bones');
			const bindPoses = arrayField(mesh, 'm_BindPose');
			if (bones.length !== bindPoses.length || bones.length === 0) {
				throw new FormatError(`invalid prefab skeleton in ${candidate.name}`);
			}
			pose = [];
			const min = [Infinity, Infinity, Infinity],
				max = [-Infinity, -Infinity, -Infinity];
			for (const [i, pointer] of bones.entries()) {
				const bone = await resolver.resolve(candidate.ref, asPPtr(pointer));
				const boneMatrix = bone && transforms.get(objectKey(bone));
				const bind = bindPoses[i];
				if (!boneMatrix || !isObject(bind)) {
					throw new FormatError(`unresolved prefab bone in ${candidate.name}`);
				}
				const bindMatrix = new Float32Array(
					Array.from({ length: 16 }, (_, k) => numberField(bind, 'e' + (k % 4) + Math.floor(k / 4))),
				);
				const posed = multiplyMatrices(boneMatrix, bindMatrix);
				pose.push(posed);
				const transformed = transformBounds(bounds, posed);
				for (let axis = 0; axis < 3; axis++) {
					min[axis] = Math.min(min[axis], transformed.center[axis] - transformed.extents[axis]);
					max[axis] = Math.max(max[axis], transformed.center[axis] + transformed.extents[axis]);
				}
			}
			// weighted positions lie inside this union, including poses whose bones move beyond the bind bounds.
			bounds = {
				center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
				extents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
			};
			matrix = trsMatrix([0, 0, 0], [0, 0, 0, 1], [1, 1, 1]);
		}
		result.push({
			name: candidate.name,
			matrix,
			bounds,
			pose,
			mesh: candidate.mesh,
			materials,
			submeshes: arrayField(mesh, 'm_SubMeshes').length,
			shadowOnly: numberField(candidate.data, 'm_CastShadows') === 3,
		});
	}
	return result;
};
