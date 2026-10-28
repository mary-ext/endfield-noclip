import { FormatError } from '@endfield-noclip/formats/binary/binary-reader';
import {
	classifyHgrpMaterial,
	type MaterialClassification,
	type MaterialRecord,
	parseMaterial,
	type ShaderSummary,
	summarizeShader,
} from '@endfield-noclip/formats/unity/material';
import { decodeMesh, type DecodedMesh } from '@endfield-noclip/formats/unity/mesh';
import { UnityClass } from '@endfield-noclip/formats/unity/serialized-file';
import { decodeTexture, type DecodedTexture, TextureClass } from '@endfield-noclip/formats/unity/texture';
import { compiledTypeOf, readOptionsOf, readTypeTreeField } from '@endfield-noclip/formats/unity/type-tree';
import { isObject, streamingInfo } from '@endfield-noclip/formats/unity/values';

import { errorText } from '../errors.ts';

import { type AssetResolver, objectKey, type ObjectRef } from './assets.ts';

// decoders bound to an AssetResolver: they follow m_StreamData and PPtrs across bundles

const TEXTURE_CLASSES: ReadonlySet<number> = new Set(Object.values(TextureClass));

/**
 * @param resolver asset resolver
 * @param ref a Mesh object
 * @param sources collects the indices of the bundles the mesh was read from
 * @returns the decoded mesh
 * @throws {FormatError} if the object isn't a mesh or doesn't decode
 */
export const loadMesh = async (
	resolver: AssetResolver,
	ref: ObjectRef,
	sources?: Set<number>,
): Promise<DecodedMesh> => {
	if (ref.info.classId !== UnityClass.Mesh) {
		throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a Mesh`);
	}
	sources?.add(ref.bundleIndex);
	const mesh = await resolver.read(ref);
	const stream = streamingInfo(mesh);
	return decodeMesh(mesh, stream && (await resolver.streamData(ref, stream, sources)));
};

/**
 * @param resolver asset resolver
 * @param ref a texture object (Texture2D, Cubemap, Texture2DArray, CubemapArray or Texture3D)
 * @param sources collects the indices of the bundles the texture was read from
 * @returns the decoded texture
 * @throws {FormatError} if the object isn't a texture or doesn't decode
 */
export const loadTexture = async (
	resolver: AssetResolver,
	ref: ObjectRef,
	sources?: Set<number>,
): Promise<DecodedTexture> => {
	if (!TEXTURE_CLASSES.has(ref.info.classId)) {
		throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a texture`);
	}
	sources?.add(ref.bundleIndex);
	const texture = await resolver.read(ref);
	const stream = streamingInfo(texture);
	return decodeTexture(
		ref.info.classId,
		texture,
		stream && (await resolver.streamData(ref, stream, sources)),
	);
};

const shaderCache = new WeakMap<AssetResolver, Map<string, Promise<ShaderSummary>>>();

/**
 * reads a shader's name and tags; only `m_ParsedForm` is materialized, and results are cached per resolver
 *
 * @param resolver asset resolver
 * @param ref a Shader object
 * @returns its summary
 */
export const loadShaderSummary = (resolver: AssetResolver, ref: ObjectRef): Promise<ShaderSummary> => {
	let cache = shaderCache.get(resolver);
	if (cache === undefined) {
		cache = new Map();
		shaderCache.set(resolver, cache);
	}
	const key = objectKey(ref);
	let cached = cache.get(key);
	if (cached === undefined) {
		cached = (async () => {
			if (ref.info.classId !== UnityClass.Shader) {
				throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a Shader`);
			}
			const bytes = await ref.file.objectBytes(ref.info);
			const parsed = readTypeTreeField(
				compiledTypeOf(ref.info.type),
				bytes,
				readOptionsOf(ref.file.file),
				'm_ParsedForm',
			);
			if (!isObject(parsed)) {
				throw new FormatError(`shader ${ref.info.pathId} has no m_ParsedForm`);
			}
			return summarizeShader(parsed);
		})();
		cache.set(key, cached);
	}
	return cached;
};

/** a material's texture slot with its texture located */
export interface ResolvedTextureSlot {
	/** the texture object, or `null` for empty slots */
	ref: ObjectRef | null;
	/** set when the PPtr couldn't be followed */
	error?: string;
}

/** a material with its shader and textures located */
export interface LoadedMaterial {
	record: MaterialRecord;
	shader: ShaderSummary;
	classification: MaterialClassification;
	textures: Record<string, ResolvedTextureSlot>;
}

/**
 * @param resolver asset resolver
 * @param ref a Material object
 * @returns the material, its shader summary, classification and located textures
 * @throws {Error} if the material or its shader can't be read
 */
export const loadMaterial = async (resolver: AssetResolver, ref: ObjectRef): Promise<LoadedMaterial> => {
	if (ref.info.classId !== UnityClass.Material) {
		throw new FormatError(`object ${ref.info.pathId} is class ${ref.info.classId}, not a Material`);
	}
	const record = parseMaterial(await resolver.read(ref));
	const shaderRef = await resolver.resolve(ref, record.shader);
	if (shaderRef === null) {
		throw new FormatError(`material ${record.name} has no shader`);
	}
	const shader = await loadShaderSummary(resolver, shaderRef);
	const textures: Record<string, ResolvedTextureSlot> = {};
	await Promise.all(
		Object.entries(record.textures).map(async ([slot, { texture }]) => {
			if (texture === null) {
				textures[slot] = { ref: null };
				return;
			}
			try {
				textures[slot] = { ref: await resolver.resolve(ref, texture) };
			} catch (error) {
				textures[slot] = { ref: null, error: errorText(error) };
			}
		}),
	);
	return { record, shader, classification: classifyHgrpMaterial(record, shader), textures };
};
