import type { DecodedMesh } from '@endfield-noclip/formats/unity/mesh';

// a minimal glTF 2.0 binary writer for eyeballing decoded assets: triangle meshes with positions, normals and
// UV0, plain base-colour materials, and nodes with matrices. Unity's left-handed space is mirrored on X into
// glTF's right-handed one (positions, normals, matrices and winding), and V is flipped.

/** a draw to place in the scene */
export interface GlbDraw {
	/** key of the mesh in {@link GlbScene.meshes} */
	mesh: string;
	submesh: number;
	/** key of the material in {@link GlbScene.materials} */
	material: string;
	/** 4×4 column-major object-to-world matrix in Unity space */
	matrix: ArrayLike<number>;
	name: string;
}

/** what {@link writeGlb} exports */
export interface GlbScene {
	meshes: Map<string, DecodedMesh>;
	materials: Map<string, { name: string; baseColor: [number, number, number, number]; doubleSided: boolean }>;
	draws: GlbDraw[];
}

interface Accessor {
	bufferView: number;
	componentType: number;
	count: number;
	type: string;
	min?: number[];
	max?: number[];
}

const FLOAT = 5126;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const TRIANGLES = 4;

/**
 * @param scene meshes, materials and draws; draws of non-triangle submeshes are skipped
 * @param origin subtracted from every draw's translation, to keep coordinates small
 * @returns the `.glb` bytes
 */
export const writeGlb = (scene: GlbScene, origin: [number, number, number]): Uint8Array => {
	const chunks: Uint8Array[] = [];
	let byteLength = 0;
	const bufferViews: { buffer: 0; byteOffset: number; byteLength: number; target: number }[] = [];
	const accessors: Accessor[] = [];
	const addView = (data: ArrayBufferView, target: number): number => {
		const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
		bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.length, target });
		chunks.push(bytes);
		byteLength += bytes.length;
		const pad = (4 - (byteLength % 4)) % 4;
		if (pad > 0) {
			chunks.push(new Uint8Array(pad));
			byteLength += pad;
		}
		return bufferViews.length - 1;
	};
	const addAccessor = (accessor: Accessor): number => {
		accessors.push(accessor);
		return accessors.length - 1;
	};

	const materialIndex = new Map<string, number>();
	const materials = [...scene.materials].map(([key, material], i) => {
		materialIndex.set(key, i);
		return {
			name: material.name,
			doubleSided: material.doubleSided,
			pbrMetallicRoughness: { baseColorFactor: material.baseColor, metallicFactor: 0, roughnessFactor: 0.8 },
		};
	});

	// one glTF mesh per (mesh, submesh, material)
	const meshes: { name: string; primitives: object[] }[] = [];
	const meshIndex = new Map<string, number>();
	const attributes = new Map<string, Record<string, number>>();
	const meshAttributes = (key: string, mesh: DecodedMesh): Record<string, number> => {
		let cached = attributes.get(key);
		if (cached !== undefined) {
			return cached;
		}
		const positions = new Float32Array(mesh.positions);
		const min = [Infinity, Infinity, Infinity];
		const max = [-Infinity, -Infinity, -Infinity];
		for (let i = 0; i < positions.length; i += 3) {
			positions[i] = -positions[i];
			for (let k = 0; k < 3; k++) {
				min[k] = Math.min(min[k], positions[i + k]);
				max[k] = Math.max(max[k], positions[i + k]);
			}
		}
		cached = {
			POSITION: addAccessor({
				bufferView: addView(positions, ARRAY_BUFFER),
				componentType: FLOAT,
				count: mesh.vertexCount,
				type: 'VEC3',
				min,
				max,
			}),
		};
		if (mesh.normals !== null) {
			const normals = new Float32Array(mesh.normals);
			for (let i = 0; i < normals.length; i += 3) {
				normals[i] = -normals[i];
			}
			cached.NORMAL = addAccessor({
				bufferView: addView(normals, ARRAY_BUFFER),
				componentType: FLOAT,
				count: mesh.vertexCount,
				type: 'VEC3',
			});
		}
		const uv = mesh.uvs[0];
		if (uv !== null && uv !== undefined && uv.dimension >= 2) {
			const uvs = new Float32Array(mesh.vertexCount * 2);
			for (let v = 0; v < mesh.vertexCount; v++) {
				uvs[v * 2] = uv.data[v * uv.dimension];
				uvs[v * 2 + 1] = 1 - uv.data[v * uv.dimension + 1];
			}
			cached.TEXCOORD_0 = addAccessor({
				bufferView: addView(uvs, ARRAY_BUFFER),
				componentType: FLOAT,
				count: mesh.vertexCount,
				type: 'VEC2',
			});
		}
		attributes.set(key, cached);
		return cached;
	};

	const nodes: object[] = [];
	for (const draw of scene.draws) {
		const mesh = scene.meshes.get(draw.mesh);
		const submesh = mesh?.submeshes[draw.submesh];
		if (mesh === undefined || submesh === undefined || submesh.topology !== 0) {
			continue;
		}
		const key = `${draw.mesh}\0${draw.submesh}\0${draw.material}`;
		let index = meshIndex.get(key);
		if (index === undefined) {
			// mirrored space: reverse the winding
			const indices = new Uint32Array(submesh.indexCount);
			for (let i = 0; i < submesh.indexCount; i += 3) {
				const at = submesh.firstIndex + i;
				indices[i] = mesh.indices[at] + submesh.baseVertex;
				indices[i + 1] = mesh.indices[at + 2] + submesh.baseVertex;
				indices[i + 2] = mesh.indices[at + 1] + submesh.baseVertex;
			}
			meshes.push({
				name: `${mesh.name}#${draw.submesh}`,
				primitives: [
					{
						attributes: meshAttributes(draw.mesh, mesh),
						indices: addAccessor({
							bufferView: addView(indices, ELEMENT_ARRAY_BUFFER),
							componentType: UNSIGNED_INT,
							count: indices.length,
							type: 'SCALAR',
						}),
						material: materialIndex.get(draw.material),
						mode: TRIANGLES,
					},
				],
			});
			index = meshes.length - 1;
			meshIndex.set(key, index);
		}
		// S·M·S with S = diag(-1, 1, 1, 1): negate the elements that mix X with Y/Z/W
		const m = Array.from(draw.matrix);
		m[12] -= origin[0];
		m[13] -= origin[1];
		m[14] -= origin[2];
		for (const i of [1, 2, 3, 4, 8, 12]) {
			m[i] = -m[i];
		}
		nodes.push({ name: draw.name, mesh: index, matrix: m });
	}

	const json = {
		asset: { version: '2.0', generator: 'endfield-noclip asset export' },
		scene: 0,
		scenes: [{ nodes: nodes.map((_, i) => i) }],
		nodes,
		meshes,
		materials,
		accessors,
		bufferViews,
		buffers: [{ byteLength }],
	};
	const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
	const jsonPadded = Math.ceil(jsonBytes.length / 4) * 4;
	const total = 12 + 8 + jsonPadded + 8 + byteLength;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, 0x46546c67, true);
	view.setUint32(4, 2, true);
	view.setUint32(8, total, true);
	view.setUint32(12, jsonPadded, true);
	view.setUint32(16, 0x4e4f534a, true);
	out.fill(0x20, 20, 20 + jsonPadded);
	out.set(jsonBytes, 20);
	let at = 20 + jsonPadded;
	view.setUint32(at, byteLength, true);
	view.setUint32(at + 4, 0x004e4942, true);
	at += 8;
	for (const chunk of chunks) {
		out.set(chunk, at);
		at += chunk.length;
	}
	return out;
};
